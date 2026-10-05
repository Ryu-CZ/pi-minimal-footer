import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

async function installExtension() {
  const result = await loadExtensions([join(root, 'extensions')], root);
  assert.deepEqual(result.errors, [], JSON.stringify(result.errors));
  assert.equal(result.extensions.length, 1);
  return result.extensions[0];
}

async function start(runtime, ctx, reason = 'startup') { await runtime.handlers.get('session_start')?.[0]?.({ reason }, ctx); }
async function emit(runtime, name, ctx, event = {}) { await runtime.handlers.get(name)?.[0]?.(event, ctx); }

// A fresh extension instance per test prevents global module state from leaking between cases.
test.beforeEach(async () => {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { enabled: true, showGitBranch: true, showSkills: true, showPath: true, showModel: true, showContext: true } }));
});
test.after(async () => { await rm(agentDir, { recursive: true, force: true }); await rm(homeDir, { recursive: true, force: true }); });

test('each real loader call creates isolated lifecycle handlers without message_end', async () => {
  const ext = await installExtension();
  const next = await installExtension();
  assert.notEqual(ext, next, 'each test fixture needs a fresh extension closure');
  for (const name of ['session_start', 'model_select', 'turn_end', 'agent_settled', 'session_compact', 'session_tree', 'session_shutdown']) assert.ok(ext.handlers.has(name), name);
  assert.equal(ext.handlers.has('message_end'), false);
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
  assert.deepEqual(boldCalls.slice(-2), ['模型\u001b[31m-red\u001b[0m', '12/128k'], 'model/context retain bold theme styling');
  assert.match(wide, /\u001b\[1m/);
  assert.equal(visibleWidth(wide), 160, 'normal layout right-aligns and fills the available width');
  const medium = stripAnsi(component.render(40)[0]);
  assert.doesNotMatch(medium, /技能|long status/, 'statuses drop before git');
  assert.match(medium, / main/);
  assert.match(medium, /模型/);
  assert.equal(visibleWidth(medium), 40, 'status-drop layout remains right-aligned');
  assert.match(medium, /^ +/);
  assert.match(medium, /12\/128k$/);
  const narrow = stripAnsi(component.render(20)[0]);
  assert.doesNotMatch(narrow, /|技能|long status/, 'git drops before model/context');
  assert.match(narrow, /模型/);
  assert.equal(visibleWidth(narrow), 20, 'branch-drop layout remains right-aligned');
  assert.match(narrow, /^ +/);
  assert.match(narrow, /12\/128k$/);
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