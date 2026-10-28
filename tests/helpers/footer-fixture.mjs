import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const piRoot = dirname(fileURLToPath(await import.meta.resolve('@earendil-works/pi-coding-agent')));
const tuiRoot = dirname(fileURLToPath(await import.meta.resolve('@earendil-works/pi-tui')));
const agentDir = await mkdtemp(join(tmpdir(), 'min-footer-agent-'));
const homeDir = await mkdtemp(join(tmpdir(), 'min-footer-home-'));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = homeDir;
const { loadExtensions } = await import(join(piRoot, 'core/extensions/loader.js'));
const { createEventBus } = await import(join(piRoot, 'core/event-bus.js'));
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

async function installExtension(eventBus) {
  const result = await loadExtensions([join(root, 'extensions')], root, eventBus);
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

export { agentDir, createEventBus, theme, makeContext, provider, stripAnsi, installExtension, start, emit, homeDir, visibleWidth, settle, usagePayload, codexContext, fakeUsageFetch, hasUsageBar };
