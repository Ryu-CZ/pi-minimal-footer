import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDir, createEventBus, makeContext, codexContext, installExtension, start, emit, settle, fakeUsageFetch } from './helpers/footer-fixture.mjs';

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
