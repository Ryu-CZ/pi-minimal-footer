import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile, chmod, readdir, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDir, installExtension, start, emit, makeContext, stripAnsi } from './helpers/footer-fixture.mjs';

const path = join(agentDir, 'settings.json');

for (const [name, preferences, expected, migrated] of [
  ['legacy false', { showSkills: false }, false, { showStatuses: false }],
  ['legacy true', { showSkills: true }, true, { showStatuses: true }],
  ['new false wins', { showSkills: true, showStatuses: false }, false, { showStatuses: false }],
  ['new true wins', { showSkills: false, showStatuses: true }, true, { showStatuses: true }],
  ['invalid new key uses default', { showSkills: false, showStatuses: null }, true, { showStatuses: null }],
  ['invalid legacy uses default', { showSkills: 'false' }, true, {}],
]) {
  test(`status setting migration: ${name}`, async (t) => {
    await writeFile(path, JSON.stringify({ unrelated: { keep: 42 }, minFooter: { showUsage: false, custom: 'keep', ...preferences } }));
    const runtime = await installExtension();
    const { ctx, ui } = makeContext();
    t.after(() => emit(runtime, 'session_shutdown', ctx));
    await start(runtime, ctx);
    assert.equal(stripAnsi(ui.component.render(120)[0]).includes('技能'), expected);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      unrelated: { keep: 42 }, minFooter: { showUsage: false, custom: 'keep', ...migrated },
    });
  });
}

test('legacy fallback survives a read-only settings file', { skip: process.getuid?.() === 0 || process.platform === 'win32' }, async (t) => {
  const saved = JSON.stringify({ minFooter: { showSkills: false } });
  await writeFile(path, saved);
  await chmod(path, 0o444);
  t.after(() => chmod(path, 0o644));
  const runtime = await installExtension();
  const { ctx, ui } = makeContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx);
  assert.equal(stripAnsi(ui.component.render(120)[0]).includes('技能'), false);
  assert.equal(await readFile(path, 'utf8'), saved);
});

test('migration is persisted once and subsequent loads do not rewrite settings', async (t) => {
  await writeFile(path, JSON.stringify({ minFooter: { showSkills: false } }));
  const writes = t.mock.method(fs, 'writeFileSync');
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const runtime = await installExtension();
  const { ctx } = makeContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx);
  assert.equal(writes.mock.callCount(), 1);
  const migrated = await readFile(path, 'utf8');
  await start(runtime, ctx, 'reload');
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(await readFile(path, 'utf8'), migrated);
});

for (const operation of ['migration', 'toggle']) {
  for (const failure of ['partial write', 'rename']) {
    test(`${operation}: ${failure} preserves the original settings and cleans temporary files`, async (t) => {
      const saved = JSON.stringify({ unrelated: { keep: 42 }, minFooter: {
        enabled: true, ...(operation === 'migration' ? { showSkills: false } : { showStatuses: false }),
      } });
      await writeFile(path, saved);
      const files = await readdir(agentDir);
      let attempts = 0;
      if (failure === 'partial write') {
        const write = fs.writeFileSync;
        t.mock.method(fs, 'writeFileSync', (target, _data, options) => {
          attempts++;
          write(target, '{partial', options);
          throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' });
        });
      } else {
        t.mock.method(fs, 'renameSync', () => {
          attempts++;
          throw Object.assign(new Error('simulated rename failure'), { code: 'EACCES' });
        });
      }
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      const runtime = await installExtension();
      const { ctx, ui } = makeContext();
      t.after(() => emit(runtime, 'session_shutdown', ctx));
      await start(runtime, ctx);
      assert.equal(stripAnsi(ui.component.render(120)[0]).includes('技能'), false);
      if (operation === 'toggle') {
        await runtime.commands.get('minfooter').handler('off', ctx);
        assert.equal(ui.component, undefined, 'session toggle works even if saving fails');
      }
      assert.ok(attempts > 0, 'the persistence failure was exercised');
      assert.equal(await readFile(path, 'utf8'), saved);
      assert.deepEqual(await readdir(agentDir), files);
    });
  }
}

test('migration preserves settings permissions', { skip: process.platform === 'win32' }, async (t) => {
  await writeFile(path, JSON.stringify({ minFooter: { showSkills: false } }));
  await chmod(path, 0o640);
  t.after(() => chmod(path, 0o644));
  const runtime = await installExtension();
  const { ctx } = makeContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).minFooter.showStatuses, false);
});

test('migration updates a symlink target without replacing the symlink', { skip: process.platform === 'win32' }, async (t) => {
  const target = join(agentDir, 'shared-settings.json');
  await writeFile(target, JSON.stringify({ unrelated: 42, minFooter: { showSkills: false } }));
  await unlink(path);
  await symlink(target, path);
  t.after(async () => { await unlink(path); await unlink(target); });
  const runtime = await installExtension();
  const { ctx } = makeContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx);
  assert.equal(fs.lstatSync(path).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { unrelated: 42, minFooter: { showStatuses: false } });
});

for (const saved of ['{broken', 'null', '[]', '{"minFooter":null}', '{"minFooter":[]}', '{"minFooter":42}']) {
  test(`migration leaves malformed settings untouched: ${saved}`, async (t) => {
    await writeFile(path, saved);
    const runtime = await installExtension();
    const { ctx } = makeContext();
    t.after(() => emit(runtime, 'session_shutdown', ctx));
    await start(runtime, ctx);
    assert.equal(await readFile(path, 'utf8'), saved);
  });
}
