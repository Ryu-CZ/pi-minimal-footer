import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import util from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { agentDir, theme, makeContext, settle, installExtension, start, emit } from './helpers/footer-fixture.mjs';

async function waitForFetchState(log, expectedCalls, retryCount, getRetryCount) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const calls = await readFile(log, 'utf8').catch(() => '');
    if (calls === expectedCalls && getRetryCount() >= retryCount) return;
    await delay(10);
  }
  assert.fail(`timed out waiting for fetch state ${JSON.stringify(expectedCalls)} and ${retryCount} retries`);
}

for (const [random, interval] of [[0, 262500], [0.5, 300000], [1, 337500]]) {
  test(`opt-in Git fetch starts immediately, retries silent failures after ${interval}ms, and stops on disposal`, async (t) => {
    const bin = await mkdtemp(join(tmpdir(), 'footer-fetch-'));
    const log = join(bin, 'calls');
    await writeFile(join(bin, 'git'), `#!/bin/sh\nif [ "$3" = fetch ]; then echo fetch >> '${log}'; exit 1; fi\necho '0 0'\n`);
    await chmod(join(bin, 'git'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    t.after(async () => { process.env.PATH = oldPath; await rm(bin, { recursive: true, force: true }); });
    t.mock.method(Math, 'random', () => random);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let scheduledRetries = 0;
    let firedRetries = 0;
    const fakeSetTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', function (callback, milliseconds, ...args) {
      if (milliseconds === interval) {
        scheduledRetries++;
        return fakeSetTimeout.call(this, (...callbackArgs) => {
          firedRetries++;
          callback(...callbackArgs);
        }, milliseconds, ...args);
      }
      return fakeSetTimeout.call(this, callback, milliseconds, ...args);
    });
    const runtime = await installExtension();
    const { ctx, ui } = makeContext();
    t.after(() => ui.component?.dispose());
    await start(runtime, ctx);
    await settle();
    assert.equal(await readFile(log, 'utf8').catch(() => ''), '', 'disabled by default');
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { gitFetch: true, gitFetchTimeoutSeconds: 'invalid' } }));
    await runtime.commands.get('minfooter').handler('on', ctx);
    await waitForFetchState(log, 'fetch\n', 1, () => scheduledRetries);
    t.mock.timers.tick(interval - 1);
    assert.equal(firedRetries, 0, 'retry does not fire before the jitter boundary');
    t.mock.timers.tick(1);
    assert.equal(firedRetries, 1);
    await waitForFetchState(log, 'fetch\nfetch\n', 2, () => scheduledRetries);
    ui.component.dispose();
    t.mock.timers.tick(interval * 2);
    assert.equal(firedRetries, 1, 'disposal cancels the scheduled retry');
    assert.equal(await readFile(log, 'utf8'), 'fetch\nfetch\n');
  });
}

test('Git queries follow live footer ownership and resume on explicit enable', async (t) => {
  let queries = 0;
  const realPromisify = util.promisify;
  const mockPromisify = t.mock.method(util, 'promisify', (fn) => {
    const original = realPromisify(fn);
    if (fn.name !== 'execFile') return original;
    return async (...args) => {
      if (args[0] !== 'git') return original(...args);
      queries++;
      return { stdout: '0 0', stderr: '' };
    };
  });
  syncBuiltinESMExports();
  t.after(() => { mockPromisify.mock.restore(); syncBuiltinESMExports(); });
  const runtime = await installExtension();
  const { ctx, ui } = makeContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx);
  await settle();
  assert.equal(queries, 1, 'startup initializes Git once');
  await runtime.commands.get('minfooter').handler('off', ctx);
  const hiddenQueries = queries;
  await emit(runtime, 'turn_end', ctx);
  await start(runtime, ctx);
  await settle();
  assert.equal(queries, hiddenQueries, 'disabled footer does not query');
  await runtime.commands.get('minfooter').handler('on', ctx);
  await settle();
  assert.equal(queries, hiddenQueries + 1, 'explicit enable resumes queries');
  ctx.ui.setFooter(undefined);
  await emit(runtime, 'model_select', ctx);
  await emit(runtime, 'input', ctx, { source: 'interactive' });
  await settle();
  assert.equal(queries, hiddenQueries + 1, 'replaced footer does not query');
  for (const mode of ['rpc', 'print', 'json']) {
    const other = await installExtension();
    const fixture = makeContext({ mode });
    await start(other, fixture.ctx);
    await emit(other, 'turn_end', fixture.ctx);
    await other.commands.get('minfooter').handler('on', fixture.ctx);
    await settle();
    assert.equal(queries, hiddenQueries + 1, `${mode} does not query`);
    await emit(other, 'session_shutdown', fixture.ctx);
  }
  assert.equal(ui.component, undefined);
});

test('Git changes pulse the whole section for one second, restart on changes, and preserve colors', async (t) => {
  const realSetTimeout = setTimeout;
  const realClearTimeout = clearTimeout;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cwd = await mkdtemp(join(tmpdir(), 'footer-git-'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  let pending;
  const { ctx, ui } = makeContext({ cwd, renderTheme: { fg: (color, s) => color === 'text' ? `<text>${s}</text>` : theme.fg(color, s), bold: (s) => `<bold>${s}</bold>` },
    tui: { requestRender() { pending?.(); } } });
  const runtime = await installExtension();
  const waitFor = async (action, predicate) => {
    await new Promise((resolve, reject) => {
      const timer = realSetTimeout(() => { pending = undefined; reject(new Error('Git refresh timed out')); }, 2000);
      pending = () => {
        if (ui.component && predicate(ui.component.render(160)[0])) {
          realClearTimeout(timer); pending = undefined; resolve();
        }
      };
      void action().catch(reject);
    });
  };
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('commit', '--allow-empty', '-m', 'base');
    git('branch', 'upstream');
    git('branch', '--set-upstream-to=upstream');
    git('commit', '--allow-empty', '-m', 'one');
    await waitFor(() => start(runtime, ctx), (s) => s.includes(' ↑1'));
    assert.doesNotMatch(ui.component.render(160)[0], /<bold>/);
    assert.match(ui.component.render(160)[0], /<text> main ↑1<\/text>/);
    git('commit', '--allow-empty', '-m', 'two');
    await waitFor(() => emit(runtime, 'agent_settled', ctx), (s) => s.includes('<bold> main ↑2</bold>'));
    await emit(runtime, 'turn_end', ctx);
    await emit(runtime, 'input', ctx, { source: 'extension' });
    await emit(runtime, 'input', ctx, { source: 'interactive' });
    await emit(runtime, 'input', ctx, { source: 'interactive' });
    t.mock.timers.tick(999);
    assert.match(ui.component.render(160)[0], /<text><bold> main ↑2<\/bold><\/text>/);
    git('commit', '--allow-empty', '-m', 'three');
    await waitFor(() => emit(runtime, 'agent_settled', ctx), (s) => s.includes('<bold> main ↑3</bold>'));
    t.mock.timers.tick(1);
    assert.match(ui.component.render(160)[0], /<bold> main ↑3<\/bold>/);
    t.mock.timers.tick(998);
    assert.match(ui.component.render(160)[0], /<bold> main ↑3<\/bold>/);
    let expiryRenders = 0;
    pending = () => expiryRenders++;
    t.mock.timers.tick(1);
    pending = undefined;
    assert.equal(expiryRenders, 1, 'expiry redraws even when Pi is idle');
    assert.match(ui.component.render(160)[0], /<text> main ↑3<\/text>/);
    // Upstream catching up pulses the whole section, but remains dim rather than white.
    git('branch', '-f', 'upstream', 'HEAD');
    await waitFor(() => emit(runtime, 'agent_settled', ctx), (s) => s.includes('<bold> main</bold>'));
    assert.doesNotMatch(ui.component.render(160)[0], /<text>/);
    t.mock.timers.tick(1000);
    assert.doesNotMatch(ui.component.render(160)[0], /<bold>/);
    git('commit', '--allow-empty', '-m', 'four');
    await waitFor(() => emit(runtime, 'agent_settled', ctx), (s) => s.includes('<bold> main ↑1</bold>'));
    await emit(runtime, 'session_shutdown', ctx);
    let afterDisposalRenders = 0;
    pending = () => afterDisposalRenders++;
    t.mock.timers.tick(1000);
    pending = undefined;
    assert.equal(afterDisposalRenders, 0, 'disposal cancels the pulse timer');
    assert.doesNotMatch(ui.component.render(160)[0], /<bold>/);
  } finally {
    await emit(runtime, 'session_shutdown', ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});
