import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentDir, theme, stripAnsi, hasUsageBar, settle, usagePayload, codexContext, fakeUsageFetch, installExtension, start, emit } from './helpers/footer-fixture.mjs';

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
  const previousToken = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = 'other-account-token';
  t.after(() => { if (previousToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN; else process.env.COPILOT_GITHUB_TOKEN = previousToken; });
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

test('Copilot quota uses the host-resolved API key ahead of ambient credentials', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const previousToken = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = 'other-account-token';
  t.after(() => { if (previousToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN; else process.env.COPILOT_GITHUB_TOKEN = previousToken; });
  const calls = fakeUsageFetch(t, () => Response.json({ quota_snapshots: { chat: { percent_remaining: 65 } } }));
  const runtime = await installExtension();
  const { ctx } = codexContext();
  ctx.model = { id: 'gpt-model', provider: 'github-copilot', baseUrl: 'https://api.individual.githubcopilot.com' };
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: 'saved-login-token' });
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx); await settle();
  assert.equal(calls[0].init.headers.Authorization, 'token saved-login-token');
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

test('showUsage false stops polling and enabling restores it on settings reload', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
  const calls = fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx);
  await settle();
  assert.equal(calls.length, 1, 'usage is enabled by default');
  assert.ok(hasUsageBar(ui));

  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { showUsage: false } }));
  await runtime.commands.get('minfooter').handler('on', ctx);
  await settle();
  assert.equal(hasUsageBar(ui), false);
  await emit(runtime, 'model_select', ctx);
  t.mock.timers.tick(480000);
  await settle();
  assert.equal(calls.length, 1, 'hidden usage cannot restart on model selection or timer expiry');

  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { showUsage: true } }));
  await runtime.commands.get('minfooter').handler('on', ctx);
  await settle();
  assert.equal(calls.length, 2);
  assert.ok(hasUsageBar(ui));
  t.mock.timers.tick(240000);
  await settle();
  assert.equal(calls.length, 3, 'polling resumes after enabling usage');
});
