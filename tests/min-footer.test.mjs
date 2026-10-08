import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const piRoot = dirname(fileURLToPath(await import.meta.resolve('@earendil-works/pi-coding-agent')));
const tuiRoot = dirname(fileURLToPath(await import.meta.resolve('@earendil-works/pi-tui')));
const agentDir = await mkdtemp(join(tmpdir(), 'min-footer-agent-'));
const homeDir = await mkdtemp(join(tmpdir(), 'min-footer-home-'));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = homeDir;
const { loadExtensions } = await import(join(piRoot, 'core/extensions/loader.js'));
const { SessionManager } = await import(join(piRoot, 'core/session-manager.js'));
const { getThemeByName } = await import(join(piRoot, 'modes/interactive/theme/theme.js'));
const { visibleWidth } = await import(join(tuiRoot, 'index.js'));

const theme = getThemeByName('dark');

// Existing lifecycle tests exercise the nominal cadence; jitter tests override this.
test.beforeEach((t) => { t.mock.method(Math, 'random', () => 0.5); });

function makeContext({ cwd = join(agentDir, 'project'), mode = 'tui', hasUI = mode === 'tui', model = 'test-model', usage = { tokens: 12000, contextWindow: 128000 }, sessionManager = SessionManager.inMemory(cwd), footerProvider = provider(), tui = { requestRender() {} }, renderTheme = theme } = {}) {
  let factory;
  let component;
  const ui = {
    setFooter(next) {
      component?.dispose?.();
      component = undefined;
      factory = next;
      if (factory) component = factory(tui, renderTheme, footerProvider);
    },
    notify() {},
    get factory() { return factory; },
    get component() { return component; },
    get tui() { return tui; },
  };
  const ctx = {
    cwd, mode, hasUI, model: model && { id: model },
    getContextUsage: () => usage,
    sessionManager,
    ui,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
  };
  return { ctx, ui, set usage(v) { usage = v; } };
}

function provider(statuses = new Map([['skill', '技能 ✅'], ['empty', '  ']]), branch = 'main') {
  let callback;
  let unsubscribeCalls = 0;
  let subscribeCalls = 0;
  return {
    getExtensionStatuses: () => statuses,
    getGitBranch: () => branch,
    onBranchChange(fn) {
      subscribeCalls++;
      callback = fn;
      return () => { unsubscribeCalls++; callback = undefined; };
    },
    fire() { callback?.(); },
    get subscribeCalls() { return subscribeCalls; },
    get unsubscribeCalls() { return unsubscribeCalls; },
  };
}

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

const hasUsageBar = (ui) => /\[[⠀⡀⣀⣄⣤⣦⣶⣷⣿]+\]↻\d\d:\d\d $/.test(stripAnsi(ui.component.render(120)[0]));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const usagePayload = (used = 35, reset = Date.now() / 1000 + 7200) => ({ rate_limit: {
  primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: reset },
  secondary_window: { used_percent: 95, limit_window_seconds: 604800, reset_at: reset + 604800 },
} });
function codexContext(options) {
  const fixture = makeContext(options);
  fixture.ctx.model.provider = 'openai-codex';
  fixture.ctx.model.baseUrl = 'https://chatgpt.com/backend-api';
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url');
  fixture.ctx.modelRegistry = { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `header.${payload}.signature` }) };
  return fixture;
}
function fakeUsageFetch(t, response = () => Response.json(usagePayload())) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return response(); };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

async function installExtension() {
  const result = await loadExtensions([join(root, 'extensions')], root);
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
  assert.equal(result.extensions.length, 1);
  return result.extensions[0];
}

async function start(runtime, ctx, reason = 'startup') { await runtime.handlers.get('session_start')?.[0]?.({ reason }, ctx); }
async function emit(runtime, name, ctx, event = {}) { await runtime.handlers.get(name)?.[0]?.(event, ctx); }

test('normalizes timer-bound settings when enabling the footer', async () => {
  for (const [value, expectedRefresh, expectedTimeout] of [[2147484, 91, 17], [2147483, 2147483, 2147483], [1, 1, 1]]) {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: {
      enabled: false, gitRefreshSeconds: value, gitFetchTimeoutSeconds: value,
    }}));
    const runtime = await installExtension();
    await runtime.commands.get('minfooter').handler('on', makeContext({ mode: 'print', hasUI: false }).ctx);
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(settings.minFooter.gitRefreshSeconds, expectedRefresh);
    assert.equal(settings.minFooter.gitFetchTimeoutSeconds, expectedTimeout);
  }
});

// A fresh extension instance per test prevents global module state from leaking between cases.
test.beforeEach(async () => {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { enabled: true, showGitBranch: true, showSkills: true, showPath: true, showModel: true, showContext: true } }));
});
test.after(async () => { await rm(agentDir, { recursive: true, force: true }); await rm(homeDir, { recursive: true, force: true }); });

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

test('each real loader call creates isolated lifecycle handlers without message_end', async () => {
  const ext = await installExtension();
  const next = await installExtension();
  assert.notEqual(ext, next, 'each test fixture needs a fresh extension closure');
  for (const name of ['session_start', 'model_select', 'turn_end', 'agent_settled', 'session_compact', 'session_tree', 'session_shutdown']) assert.ok(ext.handlers.has(name), name);
  assert.equal(ext.handlers.has('message_end'), false);
});

test('footer pads both edges and fills the visible width', async () => {
  const runtime = await installExtension();
  const { ctx, ui } = makeContext();
  await start(runtime, ctx);
  try {
    for (const width of [0, 1, 2, 3, 20, 120]) {
      const line = stripAnsi(ui.component.render(width)[0]);
      assert.equal(visibleWidth(line), width, `width=${width}`);
      if (width <= 2) assert.equal(line, ' '.repeat(width));
      else {
        assert.ok(line.startsWith(' '), `leading space at width=${width}`);
        assert.ok(line.endsWith(' '), `trailing space at width=${width}`);
      }
    }
  } finally {
    ui.component.dispose();
  }
});

test('ordinary refresh requests render without reinstalling footer or adding branch subscriptions', async () => {
  const runtime = await installExtension();
  let renders = 0;
  const p = provider();
  const fixture = makeContext({ footerProvider: p, tui: { requestRender: () => renders++ } });
  const { ctx, ui } = fixture;
  let factories = 0;
  const original = ui.setFooter;
  ui.setFooter = (f) => { factories++; original.call(ui, f); };
  await start(runtime, ctx);
  const component = ui.component;
  const installs = factories;
  assert.ok(installs >= 1);
  assert.equal(p.subscribeCalls, 1);
  let usageReads = 0;
  let tokens = 12000;
  ctx.getContextUsage = () => { usageReads++; return { tokens, contextWindow: 128000 }; };
  for (const [i, event] of ['model_select', 'turn_end', 'agent_settled', 'session_compact', 'session_tree'].entries()) {
    ctx.model.id = `updated-${i}`;
    tokens = 12000 + i * 1000;
    await emit(runtime, event, ctx);
    const line = stripAnsi(component.render(120)[0]);
    assert.match(line, new RegExp(`updated-${i}`));
    assert.match(line, new RegExp(`${Math.round(tokens / 1000)}/128k`));
  }
  assert.equal(factories, installs);
  assert.equal(p.subscribeCalls, 1);
  const readsBeforeRender = usageReads;
  component.render(120); component.render(40);
  assert.equal(usageReads, readsBeforeRender, 'render must not reread context usage');
  p.fire(); assert.ok(renders >= 1);
  await emit(runtime, 'session_shutdown', ctx);
  const afterShutdown = renders;
  p.fire(); assert.equal(renders, afterShutdown);
  component.dispose(); component.dispose();
  assert.equal(p.unsubscribeCalls, 1);
});

test('disposing an old renderer cannot clear a newer renderer; both subscriptions clean up once', async () => {
  const runtime = await installExtension();
  const oldProvider = provider();
  const newProvider = provider();
  let oldRenders = 0; let newRenders = 0;
  const { ctx, ui } = makeContext({ footerProvider: oldProvider, tui: { requestRender: () => oldRenders++ } });
  await start(runtime, ctx);
  const oldComponent = ui.component;
  const currentComponent = ui.factory({ requestRender: () => newRenders++ }, theme, newProvider);
  oldComponent.dispose(); oldComponent.dispose();
  await emit(runtime, 'model_select', ctx);
  oldProvider.fire(); newProvider.fire();
  assert.equal(oldRenders, 0);
  assert.equal(newRenders, 2, 'refresh and branch callback reach the current renderer');
  assert.equal(oldProvider.unsubscribeCalls, 1);
  currentComponent.dispose(); currentComponent.dispose();
  assert.equal(newProvider.unsubscribeCalls, 1);
});

test('isolated settings preserve unrelated options and toggle/reload boundaries', async () => {
  const settingsFile = join(agentDir, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ unrelated: 7, minFooter: { enabled: true, showModel: false }}));
  const runtime = await installExtension();
  const { ctx, ui } = makeContext();
  await start(runtime, ctx);
  assert.ok(ui.factory);
  const initial = stripAnsi(ui.component.render(120)[0]);
  assert.doesNotMatch(initial, /test-model/);
  await writeFile(settingsFile, JSON.stringify({ unrelated: 7, minFooter: { enabled: true, showModel: true }}));
  await emit(runtime, 'turn_end', ctx);
  assert.doesNotMatch(stripAnsi(ui.component.render(120)[0]), /test-model/, 'ordinary refresh retains cached feature options');
  for (const reason of ['new', 'resume', 'fork', 'reload']) {
    await start(runtime, ctx, reason);
    assert.match(stripAnsi(ui.component.render(120)[0]), /test-model/, `${reason} reloads config`);
  }
  await runtime.commands.get('minfooter').handler('off', ctx);
  const off = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.equal(off.unrelated, 7); assert.equal(off.minFooter.enabled, false); assert.equal(off.minFooter.showModel, true);
  await runtime.commands.get('minfooter').handler('on', ctx);
  const on = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.equal(on.unrelated, 7); assert.equal(on.minFooter.enabled, true);
});

test('invalid settings roots fall back to defaults and remain toggleable', async () => {
  for (const contents of ['null', '[]', 'true', '42', '"settings"', '{invalid json']) {
    await writeFile(join(agentDir, 'settings.json'), contents);
    const runtime = await installExtension();
    const { ctx, ui } = makeContext();
    await start(runtime, ctx);
    assert.match(stripAnsi(ui.component.render(120)[0]), /test-model · 12\/128k/);
    await runtime.commands.get('minfooter').handler('off', ctx);
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(settings.minFooter.enabled, false);
    await emit(runtime, 'session_shutdown', ctx);
  }
});

for (const replacement of [undefined, () => ({ render: () => ['other footer'], dispose() {} })]) {
  test(`model selection cannot restart usage after ${replacement ? 'replacement' : 'removal'} of the footer`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
    const calls = fakeUsageFetch(t);
    const runtime = await installExtension();
    const { ctx, ui } = codexContext();
    t.after(() => emit(runtime, 'session_shutdown', ctx));
    await start(runtime, ctx);
    await settle();
    assert.equal(calls.length, 1);
    ctx.ui.setFooter(replacement);
    ctx.model.id = 'other-codex-model';
    await emit(runtime, 'model_select', ctx);
    await settle();
    assert.equal(calls.length, 1, 'disposed footer must not authenticate or fetch on model selection');
    t.mock.timers.tick(240000);
    await settle();
    assert.equal(calls.length, 1, 'disposed footer must not retain polling timers');
    if (replacement) assert.deepEqual(ui.component.render(120), ['other footer']);
    else assert.equal(ui.component, undefined);

    await runtime.commands.get('minfooter').handler('on', ctx);
    await settle();
    assert.equal(calls.length, 2, 'explicit reinstallation restores usage polling');
    assert.ok(hasUsageBar(ui));
    t.mock.timers.tick(240000);
    await settle();
    assert.equal(calls.length, 3, 'reinstalled footer continues periodic polling');
  });
}

test('virtual selection cancels quota lookup and ignores late endpoint and provider events', async (t) => {
  let finishFetch;
  const calls = fakeUsageFetch(t, () => new Promise((resolve) => { finishFetch = resolve; }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx);
  await settle();
  assert.equal(calls.length, 1);

  // Pi's virtual catalog entries retain the listed provider but have no API origin.
  ctx.model = { ...ctx.model, id: 'auto', api: 'pi-virtual', baseUrl: '' };
  await emit(runtime, 'model_select', ctx);
  assert.equal(calls[0].init.signal.aborted, true);
  finishFetch(Response.json(usagePayload()));
  await settle();
  await emit(runtime, 'after_provider_response', ctx, {
    headers: { 'x-codex-primary-used-percent': '35', 'x-codex-primary-window-minutes': '300' },
  });
  await emit(runtime, 'provider_stream_event', ctx, {
    provider: 'openai-codex', model: 'test-model', data: usagePayload(),
  });
  assert.equal(hasUsageBar(ui), false);
  assert.equal(calls.length, 1, 'virtual selection must not start a quota lookup');
  assert.match(stripAnsi(ui.component.render(120)[0]), /auto/);
});

test('reset labels use clock time, days/hours, then days only without overflowing', async (t) => {
  const now = 1791200000000;
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  let reset = now;
  fakeUsageFetch(t, () => Response.json(usagePayload(35, reset / 1000)));
  for (const [remaining, expected] of [
    [day, null],
    [day + 1, '↻1d0h'],
    [day + 8 * hour + 59 * 60000, '↻1d8h'],
    [10 * day, '↻10d0h'],
    [10 * day + 1, '↻10d'],
    [12 * day + 8 * hour, '↻12d'],
  ]) {
    reset = now + remaining;
    const runtime = await installExtension();
    const { ctx, ui } = codexContext();
    await start(runtime, ctx);
    await settle();
    const line = stripAnsi(ui.component.render(120)[0]);
    if (expected) assert.ok(line.endsWith(expected + ' '), line);
    else {
      const date = new Date(reset);
      assert.ok(line.endsWith(`↻${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} `), line);
    }
    for (let width = 0; width <= 120; width++) {
      assert.ok(visibleWidth(ui.component.render(width)[0]) <= width, `width=${width}, remaining=${remaining}`);
    }
    await emit(runtime, 'session_shutdown', ctx);
  }
});

test('usage bar respects configured cell caps and invalid values fall back to ten', async (t) => {
  fakeUsageFetch(t);
  for (const [maxUsageBarCells, expected] of [[4, 4], [1, 1], [16, 16], [undefined, 10], [0, 10], [-1, 10], [2.5, 10], ['4', 10], [null, 10]]) {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: {
      maxUsageBarCells, showPath: false, showGitBranch: false, showSkills: false, showModel: false, showContext: false,
    } }));
    const runtime = await installExtension();
    const { ctx, ui } = codexContext();
    await start(runtime, ctx);
    await settle();
    try {
      const wide = stripAnsi(ui.component.render(120)[0]);
      assert.equal(wide.match(/\[([⠀⡀⣀⣄⣤⣦⣶⣷⣿]+)\]/)?.[1].length, expected, `cap=${maxUsageBarCells}`);
      assert.match(wide, /\]↻\d\d:\d\d $/);
      for (let width = 0; width <= 120; width++) {
        const line = stripAnsi(ui.component.render(width)[0]);
        assert.ok(visibleWidth(line) <= width, `cap=${maxUsageBarCells}, width=${width}`);
        const cells = line.match(/\[([⠀⡀⣀⣄⣤⣦⣶⣷⣿]+)\]/)?.[1].length ?? 0;
        assert.ok(cells <= expected, `cap=${maxUsageBarCells}, width=${width}`);
      }
    } finally {
      await emit(runtime, 'session_shutdown', ctx);
    }
  }
});

test('two-cell compact bar preserves model and context before expansion', async (t) => {
  fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  await start(runtime, ctx);
  await settle();
  try {
    assert.match(stripAnsi(ui.component.render(35)[0]), /^ test-model · 12\/128k · \[⣶⠀\]↻\d\d:\d\d $/);
  } finally {
    await emit(runtime, 'session_shutdown', ctx);
  }
});

test('usage bar grows from two to ten cells using spare columns', async (t) => {
  fakeUsageFetch(t);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { showPath: false, showGitBranch: false, showSkills: false, showModel: false, showContext: false } }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  await start(runtime, ctx);
  await settle();
  for (const [width, cells] of [[12, 2], [13, 3], [14, 4], [15, 5], [16, 6], [17, 7], [18, 8], [21, 10], [120, 10]]) {
    const line = stripAnsi(ui.component.render(width)[0]);
    const bar = line.match(/\[([⠀⡀⣀⣄⣤⣦⣶⣷⣿]+)\]↻/)?.[1];
    assert.equal(bar?.length, cells, `width=${width}`);
    assert.ok(visibleWidth(line) <= width);
  }
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\]↻/);
  assert.match(stripAnsi(ui.component.render(12)[0]), /\[⣶⠀\]↻/);
  assert.match(stripAnsi(ui.component.render(13)[0]), /\[⣿⠀⠀\]↻/);
  assert.match(stripAnsi(ui.component.render(8)[0]), /^ ↻\d\d:\d\d $/, 'reset alone survives when a bracketed cell cannot fit');
  assert.equal(stripAnsi(ui.component.render(7)[0]), ' '.repeat(7), 'usage hides when even the reset label cannot fit');
  assert.match(stripAnsi(ui.component.render(11)[0]), /^ \[⣄\]↻\d\d:\d\d $/, 'one bracketed cell fits at the boundary');
  assert.match(stripAnsi(ui.component.render(18)[0]), /^ \[[⠀⡀⣀⣄⣤⣦⣶⣷⣿]{8}\]↻\d\d:\d\d $/, 'usage-only footer uses every available column');
  for (let width = 0; width <= 120; width++) assert.ok(visibleWidth(ui.component.render(width)[0]) <= width, `width=${width}`);
  await emit(runtime, 'session_shutdown', ctx);
});

test('usage joins the model section with spaces around the dot', async (t) => {
  fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  await start(runtime, ctx);
  await settle();
  assert.match(stripAnsi(ui.component.render(120)[0]), /test-model · 12\/128k · \[[⠀⡀⣀⣄⣤⣦⣶⣷⣿]+\]/);
  await emit(runtime, 'session_shutdown', ctx);
});

test('extension statuses are individual power tabs without footer-added wrappers', async () => {
  const runtime = await installExtension();
  const { ctx, ui } = makeContext({ footerProvider: provider(new Map([['a', '🧠 Karpathy'], ['b', '🪽 Icarus'], ['empty', ' ']])) });
  await start(runtime, ctx);
  const line = stripAnsi(ui.component.render(160)[0]);
  assert.ok(line.includes(' 🧠 Karpathy  🪽 Icarus  test-model · 12/128k'), line);
  assert.doesNotMatch(line, /[()|]/);
  for (let width = 0; width <= 160; width++) assert.ok(visibleWidth(ui.component.render(width)[0]) <= width, `width=${width}`);
  await emit(runtime, 'session_shutdown', ctx);
});

test('compact model separators and optional plain-space status fallback', async () => {
  for (const powerlineSeparator of [true, false]) {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { powerlineSeparator } }));
    const runtime = await installExtension();
    const { ctx, ui } = makeContext({ footerProvider: provider(new Map([['a', 'status']])) });
    await start(runtime, ctx);
    const line = stripAnsi(ui.component.render(120)[0]);
    assert.ok(line.includes(`${powerlineSeparator ? '  ' : ' '}status${powerlineSeparator ? '  ' : ' '}test-model · 12/128k`));
    assert.match(line, /test-model · 12\/128k/);
    assert.ok(line.includes(`project${powerlineSeparator ? '  ' : ' '} main`), line);
    const noBranch = ui.factory(ui.tui, theme, provider(new Map(), null));
    assert.doesNotMatch(stripAnsi(noBranch.render(120)[0]), //);
    noBranch.dispose();
    for (let width = 0; width <= 120; width++) {
      assert.ok(visibleWidth(ui.component.render(width)[0]) <= width, `width=${width}`);
    }
    await emit(runtime, 'session_shutdown', ctx);
  }
});

test('default settings enable the footer; explicit disabled startup installs none', async () => {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ unrelated: 'kept' }));
  const enabledRuntime = await installExtension();
  const enabled = makeContext();
  await start(enabledRuntime, enabled.ctx, 'startup');
  assert.ok(enabled.ui.factory);

  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { enabled: false } }));
  const disabledRuntime = await installExtension();
  const disabled = makeContext();
  await start(disabledRuntime, disabled.ctx, 'resume');
  assert.equal(disabled.ui.factory, undefined);
});

test('rendering fits pathological widths, ANSI/Unicode status, and preserves model/context priority', async () => {
  const runtime = await installExtension();
  const statuses = new Map([['a', '\u001b[32m技能 ✅\u001b[0m'], ['b', 'long status text']]);
  const boldCalls = [];
  const renderTheme = { bold: (text) => { boldCalls.push(text); return `\u001b[1m${text}\u001b[22m`; }, fg: (_color, text) => text };
  const { ctx, ui } = makeContext({ cwd: join(homeDir, 'project', 'child'), model: '模型\u001b[31m-red\u001b[0m', footerProvider: provider(statuses), renderTheme });
  await start(runtime, ctx);
  const component = ui.component;
  for (const width of [0, 1, 2, 3, 5, 10, 20, 40, 80, 160]) assert.ok(visibleWidth(component.render(width)[0]) <= width, `width=${width}`);
  const wide = component.render(160)[0];
  assert.match(wide, /模型/);
  assert.match(wide, / main/);
  assert.match(stripAnsi(wide), /^ ~\/project\/child   main + 技能 ✅  long status text  模型-red · 12\/128k $/);
  assert.deepEqual(boldCalls.slice(-2), ['模型\u001b[31m-red\u001b[0m', '12/128k'], 'model/context retain bold theme styling');
  assert.match(wide, /\u001b\[1m/);
  assert.equal(visibleWidth(wide), 160, 'normal layout right-aligns and fills the available width');
  const medium = stripAnsi(component.render(44)[0]);
  assert.doesNotMatch(medium, /long status text/, 'long statuses shorten before git');
  assert.match(medium, / 技能 .*\.\.\./);
  assert.match(medium, / main/);
  assert.match(medium, /模型/);
  assert.equal(visibleWidth(medium), 44, 'status-drop layout remains right-aligned');
  assert.match(medium, /^  main + .*  模型/);
  assert.match(medium, /12\/128k $/);
  const narrow = stripAnsi(component.render(20)[0]);
  assert.doesNotMatch(narrow, /|技能|long status/, 'git drops before model/context');
  assert.match(narrow, /模型/);
  assert.equal(visibleWidth(narrow), 20, 'branch-drop layout remains right-aligned');
  assert.match(narrow, /^ +/);
  assert.match(narrow, /12\/128k $/);
  assert.ok(visibleWidth(component.render(5)[0]) <= 5);
});

test('each disabled feature option omits only its segment', async () => {
  for (const [key, forbidden] of [['showPath', '/project'], ['showSkills', '技能'], ['showGitBranch', 'main'], ['showModel', 'test-model'], ['showContext', '12/128k']]) {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { enabled: true, [key]: false } }));
    const runtime = await installExtension();
    const { ctx, ui } = makeContext({ cwd: join(homeDir, 'project'), footerProvider: provider() });
    await start(runtime, ctx);
    assert.doesNotMatch(stripAnsi(ui.component.render(160)[0]), new RegExp(forbidden.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')), key);
  }
});

test('mode guard leaves rpc/print without a footer while rpc hasUI remains true', async () => {
  const runtime = await installExtension();
  const rpc = makeContext({ mode: 'rpc', hasUI: true });
  await start(runtime, rpc.ctx);
  assert.equal(rpc.ui.factory, undefined);
  const print = makeContext({ mode: 'print', hasUI: false });
  await start(await installExtension(), print.ctx);
  assert.equal(print.ui.factory, undefined);
});

test('home abbreviation is boundary-safe and exact home is shortened', async () => {
  const runtime = await installExtension();
  const home = homeDir;
  const { ctx, ui } = makeContext({ cwd: home });
  await start(runtime, ctx);
  const c = ui.component;
  assert.match(c.render(120)[0], /~/);
  const child = makeContext({ cwd: join(home, 'child') });
  const childRuntime = await installExtension(); await start(childRuntime, child.ctx, 'resume');
  assert.match(child.ui.component.render(160)[0], /~\/child/);
  const sibling = makeContext({ cwd: home + '-sibling' });
  const r2 = await installExtension(); await start(r2, sibling.ctx);
  const c2 = sibling.ui.component;
  assert.match(c2.render(160)[0], new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Codex renders only shortest window as Braille and local reset time, fitting all widths', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 9, 5, 12, 0).getTime() });
  const reset = new Date(2026, 9, 5, 16, 40).getTime() / 1000;
  const data = usagePayload(35, reset);
  [data.rate_limit.primary_window, data.rate_limit.secondary_window] = [data.rate_limit.secondary_window, data.rate_limit.primary_window];
  const calls = fakeUsageFetch(t, () => Response.json(data));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  const lines = ui.component.render(120).map(stripAnsi);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /project   main + 技能 ✅  test-model/);
  assert.match(lines[0], /test-model · 12\/128k · \[⣿{3}⣤⠀{6}\]↻16:40 $/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(calls[0].init.headers['ChatGPT-Account-Id'], 'test-account');
  assert.equal(calls[0].init.redirect, 'error');
  for (const width of [0, 1, 3, 5, 6, 10, 16, 80]) {
    for (const line of ui.component.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  for (let width = 0; width <= 160; width++) {
    const rendered = ui.component.render(width);
    assert.equal(rendered.length, 1);
    assert.ok(visibleWidth(rendered[0]) <= width, `width=${width}`);
  }
  const narrow = stripAnsi(ui.component.render(32)[0]);
  assert.match(narrow, /12\/128k · \[⣶⠀\]↻16:40 $/);
  assert.doesNotMatch(narrow, /project|技能|/);
  assert.match(stripAnsi(ui.component.render(10)[0]), /↻16:40 $/);
});

for (const [random, delay] of [[0, 210000], [0.5, 240000], [1 - Number.EPSILON, 270000]]) {
  test(`usage fallback jitter schedules ${delay}ms and retains its deadline for unrelated updates`, async (t) => {
    t.mock.method(Math, 'random', () => random);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
    const calls = fakeUsageFetch(t);
    const runtime = await installExtension();
    const { ctx } = codexContext();
    t.after(() => emit(runtime, 'session_shutdown', ctx));
    await start(runtime, ctx); await settle();
    t.mock.timers.tick(60000);
    t.mock.method(Math, 'random', () => 0.5);
    await emit(runtime, 'after_provider_response', ctx, { headers: {
      'x-codex-secondary-used-percent': '95', 'x-codex-secondary-window-minutes': '10080',
    } });
    t.mock.timers.tick(delay - 60001); await settle();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1); await settle();
    assert.equal(calls.length, 2);
    // The next attempt samples again instead of retaining the previous jitter.
    t.mock.timers.tick(239999); await settle();
    assert.equal(calls.length, 2);
    t.mock.timers.tick(1); await settle();
    assert.equal(calls.length, 3);
  });
}

test('fresh response headers postpone the four-minute endpoint fallback; malformed data does not', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const calls = fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  t.mock.timers.tick(180000);
  await emit(runtime, 'after_provider_response', ctx, { headers: {
    'x-codex-primary-used-percent': '85', 'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-at': String(Date.now() / 1000 + 7200),
    'x-codex-secondary-used-percent': '95', 'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-reset-at': String(Date.now() / 1000 + 604800),
  } });
  assert.match(stripAnsi(ui.component.render(120)[0]), /⣿{8}⣤/);
  t.mock.timers.tick(239999); await settle();
  assert.equal(calls.length, 1);
  await emit(runtime, 'after_provider_response', ctx, { headers: { 'x-codex-primary-used-percent': '' } });
  t.mock.timers.tick(1); await settle();
  assert.equal(calls.length, 2);
  await emit(runtime, 'session_shutdown', ctx);
  t.mock.timers.tick(480000); await settle();
  assert.equal(calls.length, 2);
});

test('Codex stream usage updates render without polling and ignore other providers', async (t) => {
  fakeUsageFetch(t, () => new Response(null, { status: 503 }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.equal(hasUsageBar(ui), false);
  const event = { provider: 'openai-codex', model: ctx.model.id, api: 'openai-codex-responses', data: {
    type: 'codex.rate_limits', rate_limits: {
      primary: { used_percent: 0, window_minutes: 300, reset_at: Date.now() / 1000 + 7200 },
      secondary: { used_percent: 95, window_minutes: 10080, reset_at: Date.now() / 1000 + 604800 },
    },
  } };
  await emit(runtime, 'provider_stream_event', ctx, { ...event, provider: 'anthropic' });
  assert.equal(hasUsageBar(ui), false);
  await emit(runtime, 'provider_stream_event', ctx, event);
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⠀{10}\]↻\d\d:\d\d $/);
});

test('provider switch cancels pending usage and discards late results, disable stops polling', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  let resolveFetch;
  const calls = fakeUsageFetch(t, () => new Promise((resolve) => { resolveFetch = resolve; }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  ctx.model.provider = 'anthropic';
  await emit(runtime, 'model_select', ctx);
  assert.equal(calls[0].init.signal.aborted, true);
  resolveFetch(Response.json(usagePayload())); await settle();
  assert.equal(hasUsageBar(ui), false);
  t.mock.timers.tick(480000); await settle();
  assert.equal(calls.length, 1);
  ctx.model.provider = 'openai-codex';
  await emit(runtime, 'model_select', ctx); await settle();
  assert.equal(calls.length, 2);
  await runtime.commands.get('minfooter').handler('off', ctx);
  assert.equal(calls[1].init.signal.aborted, true);
  resolveFetch(Response.json(usagePayload())); await settle();
  t.mock.timers.tick(480000); await settle();
  assert.equal(calls.length, 2);
});

test('invalid, non-TUI and custom-origin Codex usage is omitted; weekly-only usage is supported', async (t) => {
  let data = { rate_limit: { primary_window: { used_percent: null, limit_window_seconds: 18000, reset_at: 1791200000 } } };
  const calls = fakeUsageFetch(t, () => Response.json(data));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.equal(hasUsageBar(ui), false);
  data = { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: 1791200000 } } };
  await start(runtime, ctx); await settle();
  assert.equal(hasUsageBar(ui), true);
  const before = calls.length;
  ctx.model.baseUrl = 'https://example.com/backend-api';
  await start(runtime, ctx); await settle();
  assert.equal(calls.length, before);
  const rpc = codexContext({ mode: 'rpc' });
  await start(runtime, rpc.ctx); await settle();
  assert.equal(calls.length, before);
});

test('Braille fills bottom-up in eighth-cell steps with warning/error colors', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  for (const [used, filled, empty, color] of [
    [0, '', '⠀'.repeat(5), 'success'],
    [2.5, '⡀', '⠀'.repeat(4), 'success'],
    [5, '⣀', '⠀'.repeat(4), 'success'],
    [7.5, '⣄', '⠀'.repeat(4), 'success'],
    [10, '⣤', '⠀'.repeat(4), 'success'],
    [12.5, '⣦', '⠀'.repeat(4), 'success'],
    [15, '⣶', '⠀'.repeat(4), 'success'],
    [17.5, '⣷', '⠀'.repeat(4), 'success'],
    [20, '⣿', '⠀'.repeat(4), 'success'],
    [35, '⣿⣶', '⠀'.repeat(3), 'success'],
    [85, '⣿'.repeat(4) + '⣀', '', 'warning'],
    [100, '⣿'.repeat(5), '', 'error'],
  ]) {
    await emit(runtime, 'after_provider_response', ctx, { headers: {
      'X-Codex-Primary-Used-Percent': String(used), 'X-Codex-Primary-Window-Minutes': '300',
      'X-Codex-Primary-Reset-At': String(Date.now() / 1000 + 7200),
    } });
    const line = ui.component.render(15)[0];
    assert.match(stripAnsi(line), new RegExp(`^ \\[${filled}${empty}\\]↻\\d\\d:\\d\\d $`));
    assert.ok(line.includes(theme.fg(color, filled)));
  }
});

test('a passive usage update wins over an older endpoint request', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  let resolveFetch;
  const calls = fakeUsageFetch(t, () => new Promise((resolve) => { resolveFetch = resolve; }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  await emit(runtime, 'after_provider_response', ctx, { headers: {
    'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300',
    'x-codex-primary-reset-at': String(Date.now() / 1000 + 7200),
  } });
  assert.equal(calls[0].init.signal.aborted, true);
  resolveFetch(Response.json(usagePayload(5))); await settle();
  assert.match(stripAnsi(ui.component.render(120)[0]), /⣿{10}/);
});

test('reset triggers a fresh check, failed refresh dims cached usage without a retry loop', async (t) => {
  t.mock.method(Math, 'random', () => 1 - Number.EPSILON);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  let data = usagePayload(35, Date.now() / 1000 + 60);
  const calls = fakeUsageFetch(t, () => data ? Response.json(data) : new Response(null, { status: 429 }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.ok(ui.component.render(120)[0].includes(theme.fg('success', '⣿⣿⣿⣤')));
  data = null;
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.timers.tick(60000); await settle();
  assert.equal(calls.length, 2);
  assert.ok(ui.component.render(120)[0].includes(theme.fg('dim', '⣿⣿⣿⣤')));
  t.mock.timers.tick(239999); await settle();
  assert.equal(calls.length, 2);
  data = usagePayload(0, Date.now() / 1000 + 18000);
  t.mock.timers.tick(1); await settle();
  assert.equal(calls.length, 3);
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⠀{10}\]↻\d\d:\d\d $/);
});

test('usage request times out and retries later; effective custom origin or non-OAuth key is never sent', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(init);
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  t.after(() => { globalThis.fetch = original; });
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  t.mock.timers.tick(9000); await settle();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(hasUsageBar(ui), false);
  t.mock.timers.tick(235000); await settle();
  assert.equal(calls.length, 2);
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'custom-secret', baseUrl: 'https://example.com/api' });
  await start(runtime, ctx); await settle();
  assert.equal(calls.length, 2);
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'plain-api-key' });
  await start(runtime, ctx); await settle();
  assert.equal(calls.length, 2);
});

test('failed credential resolution dims the last known usage rather than presenting it as fresh', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const calls = fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.ok(ui.component.render(120)[0].includes(theme.fg('success', '⣿⣿⣿⣤')));
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: 'OAuth refresh temporarily unavailable' });
  t.mock.timers.tick(240000); await settle();
  assert.equal(calls.length, 1);
  assert.ok(ui.component.render(120)[0].includes(theme.fg('dim', '⣿⣿⣿⣤')));
});

test('Pi missing-credential result clears cached usage and restored credentials recover', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const calls = fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  const validAuth = ctx.modelRegistry.getApiKeyAndHeaders;
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.equal(hasUsageBar(ui), true);
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: 'No API key found for "openai-codex"' });
  t.mock.timers.tick(240000); await settle();
  assert.equal(calls.length, 1, 'missing credentials must not send a usage request');
  assert.equal(hasUsageBar(ui), false, 'missing credentials clear rather than dim the old bar');
  ctx.modelRegistry.getApiKeyAndHeaders = validAuth;
  t.mock.timers.tick(240000); await settle();
  assert.equal(calls.length, 2);
  assert.equal(hasUsageBar(ui), true);
  assert.ok(ui.component.render(120)[0].includes(theme.fg('success', '⣿⣿⣿⣤')));
});

test('never-settling credential lookup times out and releases the next fallback attempt', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const calls = fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  let lookups = 0;
  ctx.modelRegistry.getApiKeyAndHeaders = () => { lookups++; return new Promise(() => {}); };
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.equal(lookups, 1);
  t.mock.timers.tick(9000); await settle();
  t.mock.timers.tick(235000); await settle();
  assert.equal(lookups, 2, 'timed-out authentication must release the active request');
  assert.equal(calls.length, 0);
  assert.equal(hasUsageBar(ui), false);
});

test('credential resolution after timeout cannot fetch or overwrite a newer successful attempt', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const calls = fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  const validAuth = await ctx.modelRegistry.getApiKeyAndHeaders();
  let resolveOld;
  let lookups = 0;
  ctx.modelRegistry.getApiKeyAndHeaders = () => ++lookups === 1
    ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(validAuth);
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  t.mock.timers.tick(9000); await settle();
  t.mock.timers.tick(235000); await settle();
  assert.equal(calls.length, 1, 'a fresh attempt succeeds after the old auth times out');
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\]↻\d\d:\d\d $/);
  resolveOld(validAuth); await settle();
  assert.equal(calls.length, 1, 'late authentication must not issue a fetch');
  assert.ok(ui.component.render(120)[0].includes(theme.fg('success', '⣿⣿⣿⣤')));
});

test('switching provider during authentication ignores both late resolution and late rejection', async (t) => {
  const calls = fakeUsageFetch(t, () => Response.json({ rollingUsage: { usagePercent: 70, resetInSec: 7200 } }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  const validAuth = await ctx.modelRegistry.getApiKeyAndHeaders();
  let resolveOld;
  ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise((resolve) => { resolveOld = resolve; });
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  ctx.model = { id: 'go', provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' };
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'go-key' });
  await emit(runtime, 'model_select', ctx); await settle();
  resolveOld(validAuth); await settle();
  assert.equal(calls.length, 1);
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{7}⠀{3}\]↻\d\d:\d\d $/);
  let rejectOld;
  ctx.model = { id: 'codex', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api' };
  ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise((_resolve, reject) => { rejectOld = reject; });
  await emit(runtime, 'model_select', ctx); await settle();
  ctx.model.provider = 'ollama';
  await emit(runtime, 'model_select', ctx);
  rejectOld(new Error('late auth failure')); await settle();
  assert.equal(calls.length, 1);
  assert.equal(hasUsageBar(ui), false);
});

test('pending JSON consumption times out, dims cache, and ignores late bodies after recovery', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  let resolveBody;
  let responses = 0;
  const calls = fakeUsageFetch(t, () => ++responses === 2
    ? { ok: true, json: () => new Promise((resolve) => { resolveBody = resolve; }) }
    : Response.json(usagePayload(responses === 1 ? 35 : 70)));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  t.mock.timers.tick(240000); await settle();
  t.mock.timers.tick(9000); await settle();
  assert.equal(calls[1].init.signal.aborted, true);
  assert.ok(ui.component.render(120)[0].includes(theme.fg('dim', '⣿⣿⣿⣤')));
  t.mock.timers.tick(235000); await settle();
  assert.equal(calls.length, 3);
  resolveBody(usagePayload(100)); await settle();
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{7}⠀{3}\]↻\d\d:\d\d $/);
  assert.ok(ui.component.render(120)[0].includes(theme.fg('success', '⣿⣿⣿⣿⣿⣿⣿')));
});

test('provider switching during JSON consumption cannot publish the old body', async (t) => {
  let resolveBody;
  const calls = fakeUsageFetch(t, () => ({ ok: true, json: () => new Promise((resolve) => { resolveBody = resolve; }) }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  ctx.model.provider = 'ollama';
  await emit(runtime, 'model_select', ctx);
  assert.equal(calls[0].init.signal.aborted, true);
  resolveBody(usagePayload(100)); await settle();
  assert.equal(hasUsageBar(ui), false);
});

test('malformed HTTP 200 dims valid cached usage and a later valid snapshot recovers', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  let data = usagePayload();
  const calls = fakeUsageFetch(t, () => Response.json(data));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  const cached = stripAnsi(ui.component.render(120)[0]);
  data = { rate_limit: { primary_window: { used_percent: null } } };
  t.mock.timers.tick(240000); await settle();
  assert.equal(stripAnsi(ui.component.render(120)[0]), cached);
  assert.ok(ui.component.render(120)[0].includes(theme.fg('dim', '⣿⣿⣿⣤')));
  data = usagePayload(70);
  t.mock.timers.tick(240000); await settle();
  assert.equal(calls.length, 3);
  assert.ok(ui.component.render(120)[0].includes(theme.fg('success', '⣿⣿⣿⣿⣿⣿⣿')));
});

for (const providerName of ['openai-codex', 'anthropic']) {
  test(`${providerName} weekly-only passive headers retain the short window and its fallback deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 9, 5, 12, 0).getTime() });
    const reset = Date.now() / 1000 + 7200;
    const calls = fakeUsageFetch(t, () => Response.json(providerName === 'openai-codex' ? usagePayload(35, reset) : {
      five_hour: { utilization: 35, resets_at: new Date(reset * 1000).toISOString() },
      seven_day: { utilization: 95, resets_at: new Date((reset + 604800) * 1000).toISOString() },
    }));
    const runtime = await installExtension();
    const { ctx, ui } = codexContext();
    if (providerName === 'anthropic') {
      ctx.model = { id: 'claude', provider: providerName, baseUrl: 'https://api.anthropic.com' };
      ctx.modelRegistry.isUsingOAuth = () => true;
      ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'claude-token' });
    }
    t.after(() => emit(runtime, 'session_shutdown', ctx));
    await start(runtime, ctx); await settle();
    for (const delay of [60000, 60000, 60000, 59999]) {
      t.mock.timers.tick(delay); await settle();
      await emit(runtime, 'after_provider_response', ctx, { headers: providerName === 'openai-codex' ? {
        'x-codex-secondary-used-percent': '96', 'x-codex-secondary-window-minutes': '10080',
        'x-codex-secondary-reset-at': String(reset + 604800),
      } : { 'anthropic-ratelimit-unified-7d-utilization': '0.96' } });
      assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\]↻14:00 $/);
      assert.equal(calls.length, 1);
    }
    t.mock.timers.tick(1); await settle();
    assert.equal(calls.length, 2, 'longer-window signals cannot postpone short-window fallback');
    await emit(runtime, 'after_provider_response', ctx, { headers: providerName === 'openai-codex'
      ? { 'x-codex-primary-used-percent': '70' } : { 'anthropic-ratelimit-unified-5h-utilization': '0.70' } });
    assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{7}⠀{3}\]↻14:00 $/,
      'usage-only updates retain compatible duration and reset metadata');
  });
}

test('Codex partial streams merge stable window keys and preserve omitted short-window metadata', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 9, 5, 12, 0).getTime() });
  const calls = fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  t.mock.timers.tick(180000);
  const event = { provider: 'openai-codex', model: ctx.model.id, data: { type: 'codex.rate_limits', rate_limits: {
    secondary: { used_percent: 96, window_minutes: 10080 },
  } } };
  await emit(runtime, 'provider_stream_event', ctx, event);
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\]↻14:00 $/);
  t.mock.timers.tick(60000); await settle();
  assert.equal(calls.length, 2);
  event.data.rate_limits = { primary: { used_percent: 70 } };
  await emit(runtime, 'provider_stream_event', ctx, event);
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{7}⠀{3}\]↻14:04 $/);
});

test('weekly-only passive signals do not cancel an in-flight short-window fallback or undim failed cache', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  let resolveRefresh;
  let responses = 0;
  const calls = fakeUsageFetch(t, () => ++responses === 1 ? Response.json(usagePayload())
    : new Promise((resolve) => { resolveRefresh = resolve; }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  t.mock.timers.tick(240000); await settle();
  const weekly = { headers: { 'x-codex-secondary-used-percent': '96', 'x-codex-secondary-window-minutes': '10080' } };
  await emit(runtime, 'after_provider_response', ctx, weekly);
  assert.equal(calls[1].init.signal.aborted, false, 'the selected short window still needs its refresh');
  resolveRefresh(new Response(null, { status: 503 })); await settle();
  await emit(runtime, 'after_provider_response', ctx, weekly);
  assert.ok(ui.component.render(120)[0].includes(theme.fg('dim', '⣿⣿⣿⣤')));
});

test('endpoint snapshots replace passive windows and status-only passive responses manufacture no usage', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  let data = usagePayload();
  fakeUsageFetch(t, () => Response.json(data));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  data = { rate_limit: { secondary_window: { used_percent: 100, limit_window_seconds: 604800 } } };
  t.mock.timers.tick(240000); await settle();
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{10}\] $/);
  data = { rate_limit: null };
  t.mock.timers.tick(240000); await settle();
  assert.equal(hasUsageBar(ui), false);
  await emit(runtime, 'after_provider_response', ctx, { headers: { 'x-codex-primary-status': 'allowed', 'x-codex-primary-window-minutes': '300' } });
  await emit(runtime, 'provider_stream_event', ctx, { provider: 'openai-codex', model: ctx.model.id,
    data: { type: 'codex.rate_limits', rate_limits: { primary: { status: 'allowed', window_minutes: 300 } } } });
  assert.doesNotMatch(stripAnsi(ui.component.render(120)[0]), /[⡀⣀⣄⣤⣦⣶⣷⣿]/);
});

test('local models, unsupported providers and no selected model show no usage row or usage requests', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const calls = fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.equal(hasUsageBar(ui), true);
  for (const provider of ['ollama', 'lmstudio', 'openai', undefined]) {
    ctx.model = provider ? { id: 'local-or-api-model', provider, baseUrl: 'http://localhost:11434/v1' } : undefined;
    await emit(runtime, 'model_select', ctx);
    assert.equal(hasUsageBar(ui), false);
    t.mock.timers.tick(480000); await settle();
    assert.equal(calls.length, 1);
    await start(runtime, ctx); await settle();
    assert.equal(hasUsageBar(ui), false);
    assert.equal(calls.length, 1);
  }
});

test('explicit no-limits snapshots clear cached usage; malformed durations retain dim usage', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  let data = usagePayload();
  const calls = fakeUsageFetch(t, () => Response.json(data));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.equal(hasUsageBar(ui), true);
  for (const [missing, absent] of [
    [{ rate_limit: null }, true],
    [{ rate_limit: { primary_window: null, secondary_window: null } }, true],
    [{ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 0, reset_at: Date.now() / 1000 + 604800 } } }, false],
  ]) {
    data = missing;
    t.mock.timers.tick(240000); await settle();
    assert.equal(hasUsageBar(ui), !absent);
    if (!absent) assert.ok(ui.component.render(120)[0].includes(theme.fg('dim', '⠀'.repeat(10))));
    data = usagePayload(0);
    t.mock.timers.tick(240000); await settle();
    assert.equal(hasUsageBar(ui), true, 'zero usage remains a real usage bar, distinct from no limits');
  }
  assert.equal(calls.length, 7);
});

test('missing or non-OAuth credentials hide the usage bar without sending usage requests', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const calls = fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  const validAuth = ctx.modelRegistry.getApiKeyAndHeaders;
  for (const apiKey of [undefined, 'plain-api-key']) {
    ctx.modelRegistry.getApiKeyAndHeaders = validAuth;
    await start(runtime, ctx); await settle();
    assert.equal(hasUsageBar(ui), true);
    const before = calls.length;
    ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey });
    t.mock.timers.tick(240000); await settle();
    assert.equal(hasUsageBar(ui), false);
    assert.equal(calls.length, before);
    await start(runtime, ctx); await settle();
    assert.equal(hasUsageBar(ui), false);
    assert.equal(calls.length, before);
  }
});

test('switching away and back cannot restore an old provider result; only current usage survives failed refresh', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  let request = 0;
  let resolveOld;
  let resolveCurrent;
  const calls = fakeUsageFetch(t, () => {
    request++;
    if (request === 1) return Response.json(usagePayload(35));
    if (request === 2) return new Promise((resolve) => { resolveOld = resolve; });
    if (request === 3) return new Promise((resolve) => { resolveCurrent = resolve; });
    return new Response(null, { status: 503 });
  });
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.equal(hasUsageBar(ui), true);
  t.mock.timers.tick(240000); await settle();
  ctx.model.provider = 'ollama';
  await emit(runtime, 'model_select', ctx);
  assert.equal(hasUsageBar(ui), false, 'previous provider usage disappears immediately');
  assert.equal(calls[1].init.signal.aborted, true);
  ctx.model.provider = 'openai-codex';
  await emit(runtime, 'model_select', ctx); await settle();
  assert.equal(hasUsageBar(ui), false, 'switching back waits for current data');
  resolveCurrent(Response.json(usagePayload(70))); await settle();
  resolveOld(Response.json(usagePayload(100))); await settle();
  assert.match(stripAnsi(ui.component.render(120)[0]), /⣿{7}⠀{3}/);
  t.mock.timers.tick(240000); await settle();
  assert.ok(ui.component.render(120)[0].includes(theme.fg('dim', '⣿⣿⣿⣿⣿⣿⣿')));
  assert.match(stripAnsi(ui.component.render(120)[0]), /⣿{7}⠀{3}/);
  ctx.model.provider = 'ollama';
  await emit(runtime, 'model_select', ctx);
  assert.equal(hasUsageBar(ui), false, 'dimmed data also disappears on switch');
});

test('upstream rolling-usage providers render only their short window and use their own usage endpoints', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const reset = new Date(Date.now() + 7200000).toISOString();
  const cases = [
    ['anthropic', 'https://api.anthropic.com', 'https://api.anthropic.com/api/oauth/usage', {
      five_hour: { utilization: 35, resets_at: reset }, seven_day: { utilization: 99, resets_at: reset },
    }],
    ['minimax', 'https://api.minimax.io/anthropic', 'https://api.minimax.io/v1/token_plan/remains', {
      base_resp: { status_code: 0 }, model_remains: [
        { model_name: 'video', current_interval_status: 1, current_interval_remaining_percent: 1 },
        { model_name: 'general', current_interval_status: 1, current_interval_remaining_percent: 65,
          start_time: Date.now() - 10800000, end_time: Date.now() + 7200000, current_weekly_remaining_percent: 1 },
      ],
    }],
    ['minimax-cn', 'https://api.minimaxi.com/anthropic', 'https://api.minimaxi.com/v1/token_plan/remains', {
      model_remains: [{ model_name: 'general', current_interval_remaining_percent: 65, end_time: Date.now() + 7200000 }],
    }],
    ['kimi-coding', 'https://api.kimi.com/coding', 'https://api.kimi.com/coding/v1/usages', {
      limits: [
        { window: { duration: 10080, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, remaining: 1, resetTime: reset } },
        { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, remaining: 65, resetTime: reset } },
      ], usage: { limit: 100, remaining: 1, resetTime: reset },
    }],
    ['opencode-go', 'https://opencode.ai/zen/go/v1', 'https://opencode.ai/zen/go/v1/usage', {
      rollingUsage: { usagePercent: 35, resetInSec: 7200 }, weeklyUsage: { usagePercent: 99, resetInSec: 604800 },
    }],
  ];
  let data;
  const calls = fakeUsageFetch(t, () => Response.json(data));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  ctx.modelRegistry.isUsingOAuth = () => true;
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'provider-token' });
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  for (const [providerName, baseUrl, endpoint, payload] of cases) {
    data = payload;
    ctx.model = { id: 'test-model', provider: providerName, baseUrl };
    await start(runtime, ctx); await settle();
    assert.equal(calls.at(-1)?.url, endpoint);
    assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\]↻\d\d:\d\d $/);
    assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer provider-token');
  }
});

test('Gemini uses selected model usage, omits unknown reset time, and refreshes on model switch', async (t) => {
  const calls = fakeUsageFetch(t, () => Response.json({ buckets: [
    { modelId: 'gemini-pro', remainingFraction: 0.65 },
    { modelId: 'gemini-flash', remainingFraction: 0.1 },
  ] }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  ctx.model = { id: 'gemini-pro', provider: 'google-gemini-cli', baseUrl: 'https://cloudcode-pa.googleapis.com' };
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'gemini-access' });
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\] $/);
  assert.doesNotMatch(stripAnsi(ui.component.render(120)[0]), /↻/);
  assert.equal(calls[0].url, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
  assert.equal(calls[0].init.method, 'POST');
  ctx.model = { ...ctx.model, id: 'gemini-flash' };
  await emit(runtime, 'model_select', ctx); await settle();
  assert.equal(calls.length, 2);
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{9}⠀\] $/);
});

test('switches between supported providers cancel old requests and never display their late results', async (t) => {
  let resolveOld;
  let calls = 0;
  fakeUsageFetch(t, () => ++calls === 1 ? new Promise((resolve) => { resolveOld = resolve; })
    : Response.json({ rollingUsage: { usagePercent: 0, resetInSec: 7200 } }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  ctx.model = { id: 'other', provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1' };
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'go-key' });
  await emit(runtime, 'model_select', ctx); await settle();
  resolveOld(Response.json(usagePayload(100))); await settle();
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⠀{10}\]↻\d\d:\d\d $/);
});

test('Anthropic response headers provide accurate small percentages without fractional guessing', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const calls = fakeUsageFetch(t, () => Response.json({ five_hour: { utilization: 1, resets_at: new Date(Date.now() + 7200000).toISOString() } }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  ctx.model = { id: 'claude', provider: 'anthropic', baseUrl: 'https://api.anthropic.com' };
  ctx.modelRegistry.isUsingOAuth = () => true;
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'claude-token' });
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⡀⠀{9}\]↻\d\d:\d\d $/);
  await emit(runtime, 'after_provider_response', ctx, { headers: {
    'anthropic-ratelimit-unified-5h-utilization': '0.35', 'anthropic-ratelimit-unified-5h-reset': String(Date.now() / 1000 + 7200),
    'anthropic-ratelimit-unified-7d-utilization': '0.95',
  } });
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\]↻\d\d:\d\d $/);
  t.mock.timers.tick(239999); await settle();
  assert.equal(calls.length, 1);
});

test('Copilot monthly usage uses GitHub login token, ignores unlimited buckets, and omits absent reset time', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const authPath = join(agentDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ 'github-copilot': { type: 'oauth', refresh: 'github-login-token', access: 'inference-only-token', expires: Date.now() + 3600000 } }));
  t.after(() => rm(authPath, { force: true }));
  let data = { quota_snapshots: { premium_interactions: { percent_remaining: 65, unlimited: false }, chat: { percent_remaining: 0, unlimited: true } }, quota_reset_date_utc: new Date(Date.now() + 2592000000).toISOString() };
  const calls = fakeUsageFetch(t, () => Response.json(data));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  ctx.model = { id: 'gpt-model', provider: 'github-copilot', baseUrl: 'https://api.individual.githubcopilot.com' };
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'inference-only-token' });
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.equal(calls[0].url, 'https://api.github.com/copilot_internal/user');
  assert.equal(calls[0].init.headers.Authorization, 'token github-login-token');
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\]↻30d $/);
  data = { quota_snapshots: { premium_interactions: { percent_remaining: 65 } } };
  t.mock.timers.tick(240000); await settle();
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\] $/);
  data = { quota_snapshots: { premium_interactions: { percent_remaining: 65, unlimited: true } } };
  t.mock.timers.tick(240000); await settle();
  assert.doesNotMatch(stripAnsi(ui.component.render(120)[0]), /[⠀⡀⣀⣄⣤⣦⣶⣷⣿]/);
});

test('provider API errors and malformed numbers dim cached usage; custom origins are never queried', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  let data = { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: 65 }] };
  const calls = fakeUsageFetch(t, () => Response.json(data));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  ctx.model = { id: 'minimax-model', provider: 'minimax', baseUrl: 'https://api.minimax.io/anthropic' };
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'minimax-key' });
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\] $/);
  data = { base_resp: { status_code: 1004, status_msg: 'auth failed' } };
  t.mock.timers.tick(240000); await settle();
  assert.ok(ui.component.render(120)[0].includes(theme.fg('dim', '⣿⣿⣿⣤')));
  data = { model_remains: [{ current_interval_remaining_percent: null }] };
  t.mock.timers.tick(240000); await settle();
  assert.ok(ui.component.render(120)[0].includes(theme.fg('dim', '⣿⣿⣿⣤')));
  const before = calls.length;
  for (const provider of ['anthropic', 'github-copilot', 'google-gemini-cli', 'minimax', 'minimax-cn', 'kimi-coding', 'opencode-go']) {
    ctx.model = { id: 'other', provider, baseUrl: 'https://custom.example.com/api' };
    await emit(runtime, 'model_select', ctx); await settle();
    assert.equal(calls.length, before);
  }
});

test('Kimi accepts the actual Pi OAuth bearer-header contract', async (t) => {
  const aiRoot = dirname(fileURLToPath(await import.meta.resolve('@earendil-works/pi-ai')));
  const { kimiCodingOAuth } = await import(join(aiRoot, 'auth/oauth/kimi-coding.js'));
  const auth = await kimiCodingOAuth.toAuth({ type: 'oauth', access: 'kimi-oauth-access', refresh: 'refresh', expires: Date.now() + 3600000 });
  const calls = fakeUsageFetch(t, () => Response.json({ limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, remaining: 65 } }] }));
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  ctx.model = { id: 'kimi', provider: 'kimi-coding', baseUrl: 'https://api.kimi.com/coding' };
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, ...auth });
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.equal(calls[0]?.url, 'https://api.kimi.com/coding/v1/usages');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer kimi-oauth-access');
  assert.match(stripAnsi(ui.component.render(120)[0]), /\[⣿{3}⣤⠀{6}\] $/);
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
