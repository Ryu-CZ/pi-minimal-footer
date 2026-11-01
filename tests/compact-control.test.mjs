import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDir, createEventBus, makeContext, installExtension, start, emit } from './helpers/footer-fixture.mjs';

for (const savedCompact of [false, true]) {
  test(`compact override supports true/false/null with saved ${savedCompact}`, async (t) => {
    const path = join(agentDir, 'settings.json');
    const saved = JSON.stringify({ minFooter: { compactEditor: savedCompact, showUsage: false } });
    await writeFile(path, saved);
    const bus = createEventBus();
    const runtime = await installExtension(bus);
    const { ctx, ui } = makeContext();
    t.after(() => emit(runtime, 'session_shutdown', ctx));
    const compact = enabled => bus.emit('pi-minimal-footer:set-compact-enabled', { enabled });
    const footer = enabled => bus.emit('pi-minimal-footer:set-enabled', { enabled });
    const check = expected => assert.equal(ui.component.render(120).length, expected ? 0 : 1);
    compact(!savedCompact);
    await start(runtime, ctx);
    check(savedCompact);
    for (const value of [true, false, null]) {
      ui.collapsePaste('full draft\n'.repeat(30));
      compact(value);
      check(value ?? savedCompact);
      assert.equal(ui.getEditorText(), 'full draft\n'.repeat(30));
      const swaps = ui.editorSwaps;
      const component = ui.component;
      compact(value);
      for (const invalid of [null, {}, { enabled: 'false' }, { enabled: 0 }]) {
        bus.emit('pi-minimal-footer:set-compact-enabled', invalid);
      }
      assert.equal(ui.editorSwaps, swaps);
      assert.equal(ui.component, component);
    }
    footer(false);
    compact(true);
    assert.equal(ui.component, undefined);
    assert.equal(ui.getEditorComponent(), undefined);
    footer(true);
    check(true);
    compact(!savedCompact);
    await start(runtime, ctx, 'reload');
    check(savedCompact);

    const otherEditor = () => {};
    ui.setEditorComponent(otherEditor);
    compact(false);
    compact(true);
    check(false);
    assert.equal(ui.getEditorComponent(), otherEditor);
    ui.setFooter(() => ({ render: () => ['other footer'] }));
    compact(false);
    compact(true);
    assert.deepEqual(ui.component.render(120), ['other footer']);
    assert.equal(ui.getEditorComponent(), otherEditor);
    await emit(runtime, 'session_shutdown', ctx);
    compact(false);
    assert.equal(ui.getEditorComponent(), otherEditor);
    assert.equal(await readFile(path, 'utf8'), saved);
  });
}
