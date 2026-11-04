import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDir, makeContext, installExtension, start, emit, stripAnsi, visibleWidth, createEventBus, codexContext, fakeUsageFetch, settle } from './helpers/footer-fixture.mjs';

const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const usage = (total) => ({ cost: { total } });
const entries = [
  { type: 'message', message: { role: 'assistant', usage: usage(0.1) } },
  { type: 'usage', usage: usage(0.02) },
  { type: 'compaction', usage: usage(0.003) },
  { type: 'branch_summary', usage: usage(0.004) },
  { type: 'message', message: { role: 'toolResult', usage: usage(0.005) } },
  { type: 'message', message: { role: 'user' } },
];

test('PAYG fallback sums persisted session costs and stays within terminal width', async (t) => {
  const runtime = await installExtension();
  const { ctx, ui } = makeContext();
  ctx.model = { ...ctx.model, provider: 'anthropic', cost: rates };
  ctx.sessionManager = { getEntries: () => entries };
  await start(runtime, ctx);
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  assert.match(stripAnsi(ui.component.render(120)[0]), /~\$0\.132/);
  for (let width = 1; width <= 160; width++) {
    const line = stripAnsi(ui.component.render(width)[0]);
    assert.ok(visibleWidth(line) <= width);
    if (line.includes('$')) assert.ok(line.includes('~$0.132'), 'never truncate cost');
  }
  ctx.sessionManager = { getEntries: () => [...entries, { type: 'usage', usage: usage(0.1) }] };
  await emit(runtime, 'turn_end', ctx);
  assert.match(stripAnsi(ui.component.render(120)[0]), /~\$0\.232/);
  ctx.model = { id: 'local', provider: 'llamacpp' };
  await emit(runtime, 'model_select', ctx);
  assert.doesNotMatch(stripAnsi(ui.component.render(120)[0]), /\$/);
});

test('unpriced local models and subscriptions hide cost even after earlier paid turns', async () => {
  for (const [provider, cost, oauth, subscription] of [
    ['llamacpp', undefined, false],
    ['llamacpp', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, false],
    ['llamacpp', { input: NaN, output: Infinity, cacheRead: -1 }, false],
    ['kimi-coding', rates, false],
    ['opencode-go', rates, false],
    ['anthropic', rates, true, true],
    ['openai-codex', rates, true, undefined],
  ]) {
    const runtime = await installExtension();
    const { ctx, ui } = makeContext();
    ctx.model = { ...ctx.model, provider, cost };
    ctx.sessionManager = { getEntries: () => entries };
    ctx.modelRegistry = { isUsingOAuth: () => oauth, getProvider: () => ({ auth: { oauth: { isSubscription: subscription } } }) };
    await start(runtime, ctx);
    try { assert.doesNotMatch(stripAnsi(ui.component.render(120)[0]), /\$/); }
    finally { await emit(runtime, 'session_shutdown', ctx); }
  }
});

test('priced zero-cost session shows estimate; usage control hides and restores it', async (t) => {
  const bus = createEventBus();
  const runtime = await installExtension(bus);
  const { ctx, ui } = makeContext();
  ctx.model.cost = rates;
  await start(runtime, ctx);
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  assert.match(stripAnsi(ui.component.render(120)[0]), /~\$0\.000/);
  bus.emit('pi-minimal-footer:set-usage-enabled', { enabled: false });
  assert.doesNotMatch(stripAnsi(ui.component.render(120)[0]), /\$/);
  bus.emit('pi-minimal-footer:set-usage-enabled', { enabled: null });
  assert.match(stripAnsi(ui.component.render(120)[0]), /~\$0\.000/);
});

test('saved showUsage false hides the billing fallback', async (t) => {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { showUsage: false } }));
  const runtime = await installExtension();
  const { ctx, ui } = makeContext();
  ctx.model.cost = rates;
  await start(runtime, ctx);
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  assert.doesNotMatch(stripAnsi(ui.component.render(120)[0]), /\$/);
});

test('compact editor shows the same cost fallback and respects usage control', async (t) => {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { compactEditor: true } }));
  const bus = createEventBus();
  const runtime = await installExtension(bus);
  const { ctx, ui } = makeContext();
  ctx.model.cost = rates;
  await start(runtime, ctx);
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  assert.deepEqual(ui.component.render(120), []);
  const editor = ui.getEditorComponent()(
    { terminal: { rows: 30 }, requestRender() {} },
    { borderColor: text => text, selectList: {} },
    { matches: () => false },
  );
  assert.match(stripAnsi(editor.renderBottomBorder(120, 0)), /~\$0\.000/);
  bus.emit('pi-minimal-footer:set-usage-enabled', { enabled: false });
  assert.doesNotMatch(stripAnsi(editor.renderBottomBorder(120, 0)), /\$/);
});

test('available quota takes priority over a billing estimate', async (t) => {
  fakeUsageFetch(t);
  const runtime = await installExtension();
  const { ctx, ui } = codexContext();
  ctx.model.cost = rates;
  await start(runtime, ctx);
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await settle();
  const line = stripAnsi(ui.component.render(120)[0]);
  assert.match(line, /\[[⠀⡀⣀⣄⣤⣦⣶⣷⣿]+\]/);
  assert.doesNotMatch(line, /\$/);
});
