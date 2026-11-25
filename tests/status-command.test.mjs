import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDir, createEventBus, makeContext, codexContext, installExtension, start, emit, settle, fakeUsageFetch } from './helpers/footer-fixture.mjs';

function assistantMessage(provider, model, responseModel) {
  return {
    role: 'assistant', content: [], api: 'test-api', provider, model,
    ...(responseModel === undefined ? {} : { responseModel }),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
}

async function readStatus(runtime, ctx) {
  let message;
  ctx.ui.notify = (value) => { message = value; };
  await runtime.commands.get('minfooter').handler('status', ctx);
  return message;
}

test('status and unknown arguments never toggle, write settings, or replace the renderer', async (t) => {
  const bus = createEventBus();
  const runtime = await installExtension(bus);
  const { ctx, ui } = makeContext();
  const messages = [];
  ui.notify = (message) => messages.push(message);
  await start(runtime, ctx);
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  const before = await readFile(join(agentDir, 'settings.json'), 'utf8');
  const renderer = ui.component;
  await runtime.commands.get('minfooter').handler('status', ctx);
  assert.match(messages.at(-1), /Layout: normal/);
  assert.match(messages.at(-1), /^Display: showPath=true[^\n]*maxUsageBarCells=10$/m);
  assert.match(messages.at(-1), /^Git: showGitBranch=true, gitFetch=false, gitRefreshSeconds=91, gitFetchTimeoutSeconds=17$/m);
  for (const setting of ['contextAsPercentage=false', 'powerlineSeparator=true', 'gitFetch=false', 'gitRefreshSeconds=91', 'gitFetchTimeoutSeconds=17', 'maxUsageBarCells=10']) {
    assert.ok(messages.at(-1).includes(setting), setting);
  }
  assert.match(messages.pop(), /unsupported provider or custom endpoint/);
  for (const arg of ['help', 'of', 'on extra']) {
    await runtime.commands.get('minfooter').handler(arg, ctx);
    assert.match(messages.pop(), /Usage:.*status/);
    assert.equal(ui.component, renderer);
  }
  assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), before);
  bus.emit('pi-minimal-footer:set-usage-enabled', { enabled: false });
  bus.emit('pi-minimal-footer:set-cost-enabled', { enabled: false });
  await runtime.commands.get('minfooter').handler('status', ctx);
  assert.match(messages.pop(), /Usage: disabled[\s\S]*Cost: disabled/);
  ui.setFooter(() => ({ render: () => ['other'] }));
  await runtime.commands.get('minfooter').handler('status', ctx);
  assert.match(messages.pop(), /Ownership: not owned[\s\S]*Layout: inactive/);
});

test('status reports only safe response metadata from the latest active-branch assistant for the selected model', async (t) => {
  const runtime = await installExtension();
  const { ctx } = makeContext();
  ctx.model.provider = 'test-provider';
  ctx.model.id = 'selected-model';
  await start(runtime, ctx);
  t.after(() => emit(runtime, 'session_shutdown', ctx));

  const cases = [
    ['different reported model', assistantMessage('test-provider', 'selected-model', 'routed-model'), true],
    ['same as selected model', assistantMessage('test-provider', 'selected-model', 'selected-model'), false],
    ['missing response metadata', assistantMessage('test-provider', 'selected-model'), false],
    ['different provider', assistantMessage('other-provider', 'selected-model', 'routed-model'), false],
    ['different selected model', assistantMessage('test-provider', 'other-model', 'routed-model'), false],
    ['newline in metadata', assistantMessage('test-provider', 'selected-model', 'unsafe\nmodel'), false],
    ['trailing newline in metadata', assistantMessage('test-provider', 'selected-model', 'routed-model\n'), false],
    ['terminal control in metadata', assistantMessage('test-provider', 'selected-model', '\u001b[31mrouted-model'), false],
  ];
  for (const [label, response, shown] of cases) {
    ctx.sessionManager = makeContext().ctx.sessionManager;
    ctx.sessionManager.appendMessage(response);
    const message = await readStatus(runtime, ctx);
    assert.equal(/Last response model:/.test(message), shown, label);
  }

  ctx.sessionManager = makeContext().ctx.sessionManager;
  ctx.sessionManager.appendMessage(assistantMessage('test-provider', 'selected-model', 'older-routed-model'));
  ctx.sessionManager.appendMessage({ role: 'user', content: 'next', timestamp: Date.now() });
  ctx.sessionManager.appendMessage(assistantMessage('test-provider', 'selected-model'));
  assert.doesNotMatch(await readStatus(runtime, ctx), /Last response model:/, 'missing metadata must not backfill from an older response');
});

test('status follows the current model, session, and active branch without retaining prior response metadata', async (t) => {
  const runtime = await installExtension();
  const { ctx } = makeContext();
  ctx.model.provider = 'test-provider';
  ctx.model.id = 'selected-model';
  await start(runtime, ctx);
  t.after(() => emit(runtime, 'session_shutdown', ctx));

  const root = ctx.sessionManager.appendMessage({ role: 'user', content: 'start', timestamp: Date.now() });
  ctx.sessionManager.appendMessage(assistantMessage('test-provider', 'selected-model', 'branch-a-model'));
  assert.match(await readStatus(runtime, ctx), /Last response model: branch-a-model/);

  ctx.model.id = 'other-model';
  assert.doesNotMatch(await readStatus(runtime, ctx), /Last response model:/);
  ctx.model.id = 'selected-model';

  ctx.sessionManager.branch(root);
  assert.doesNotMatch(await readStatus(runtime, ctx), /Last response model:/, 'the abandoned branch must not supply metadata');

  ctx.sessionManager.appendMessage(assistantMessage('test-provider', 'selected-model', 'branch-b-model'));
  assert.match(await readStatus(runtime, ctx), /Last response model: branch-b-model/);

  ctx.sessionManager = makeContext().ctx.sessionManager;
  assert.doesNotMatch(await readStatus(runtime, ctx), /Last response model:/, 'a new session must not retain prior metadata');
});

test('minfooter without arguments toggles ownership and persists each state', async (t) => {
  const settingsPath = join(agentDir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ theme: 'dark', minFooter: { enabled: true, showPath: false } }));
  const runtime = await installExtension();
  const { ctx, ui } = makeContext();
  const messages = [];
  ui.notify = (message) => messages.push(message);
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx);
  const firstRenderer = ui.component;
  assert.ok(firstRenderer);

  for (const enabled of [false, true]) {
    await runtime.commands.get('minfooter').handler('', ctx);
    assert.equal(Boolean(ui.component), enabled);
    assert.equal(messages.at(-1), `Minimal footer ${enabled ? 'enabled' : 'disabled'}`);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(settings.minFooter.enabled, enabled);
    assert.equal(settings.minFooter.showPath, false);
    assert.equal(settings.theme, 'dark');
  }
  assert.notEqual(ui.component, firstRenderer, 're-enabling installs a fresh renderer');
});

test('status reports compact layout and disabled footer without installing anything', async (t) => {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { compactEditor: true } }));
  const runtime = await installExtension();
  const { ctx, ui } = makeContext();
  let message;
  ui.notify = (value) => { message = value; };
  await start(runtime, ctx);
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await runtime.commands.get('minfooter').handler('status', ctx);
  assert.match(message, /Layout: compact/);
  ui.setEditorComponent(() => ({}));
  await runtime.commands.get('minfooter').handler('status', ctx);
  assert.match(message, /Layout: normal[\s\S]*Compact requested: yes/);
  await runtime.commands.get('minfooter').handler('off', ctx);
  await runtime.commands.get('minfooter').handler('status', ctx);
  assert.match(message, /Footer: disabled[\s\S]*Layout: inactive/);
});

test('quota diagnostics expose safe reasons without new authentication or requests', async (t) => {
  for (const outcome of ['missing', 'failed', 'empty', 'fresh', 'expired']) {
    const runtime = await installExtension();
    const { ctx, ui } = codexContext();
    let authCalls = 0;
    const auth = ctx.modelRegistry.getApiKeyAndHeaders;
    ctx.modelRegistry.getApiKeyAndHeaders = async (...args) => {
      authCalls++;
      if (outcome === 'missing') return { ok: false, error: 'No API key found for "openai-codex"' };
      return auth(...args);
    };
    const calls = fakeUsageFetch(t, () => {
      if (outcome === 'failed') throw new Error('SECRET_TOKEN');
      return Response.json({ rate_limit: outcome === 'empty' ? null : { primary_window: {
        used_percent: 30, limit_window_seconds: 18000,
        reset_at: Date.now() / 1000 + (outcome === 'expired' ? -60 : 3600),
      } } });
    });
    let message;
    ui.notify = (value) => { message = value; };
    await start(runtime, ctx);
    await settle(); await settle();
    const before = [authCalls, calls.length];
    await runtime.commands.get('minfooter').handler('status', ctx);
    assert.match(message, {
      missing: /credentials unavailable or authentication\/endpoint unsupported/,
      failed: /refresh failed/, empty: /no quota reported/,
      fresh: /available/, expired: /reset time passed/,
    }[outcome]);
    assert.doesNotMatch(message, /SECRET_TOKEN|Authorization|header\./);
    assert.deepEqual([authCalls, calls.length], before);
    await emit(runtime, 'session_shutdown', ctx);
  }
});
