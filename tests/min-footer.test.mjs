import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDir, createEventBus, theme, makeContext, provider, stripAnsi, installExtension, start, emit } from './helpers/footer-fixture.mjs';

test('context percentage is opt-in and preserves unknown usage', async () => {
  for (const [setting, usage, expected] of [
    [undefined, { tokens: 988, contextWindow: 500000 }, '0.99k/500k'],
    ...[
      [0, '0k'], [1, '0.001k'], [12, '0.012k'], [110, '0.11k'],
      [780, '0.78k'], [990, '0.99k'], [1000, '1.0k'], [9000, '9.0k'],
      [9999, '10k'], [10000, '10k'], [124000, '124k'],
    ].map(([tokens, formatted]) => [false, { tokens, contextWindow: 1000000 }, `${formatted}/1000k`]),
    [false, { tokens: 123500, contextWindow: 500000 }, '124k/500k'],
    [true, { tokens: 123500, contextWindow: 500000 }, '24.7%/500k'],
    [true, { tokens: 0, contextWindow: 500000 }, '0.0%/500k'],
    [true, { tokens: null, contextWindow: 500000 }, '?/500k'],
    [true, { tokens: 10, contextWindow: 0 }, '?/0'],
    [true, undefined, '?'],
  ]) {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { contextAsPercentage: setting } }));
    const runtime = await installExtension();
    const fixture = makeContext();
    fixture.usage = usage;
    try {
      await start(runtime, fixture.ctx);
      assert.ok(stripAnsi(fixture.ui.component.render(160)[0]).includes(` · ${expected}`));
    } finally {
      await emit(runtime, 'session_shutdown', fixture.ctx);
    }
  }
});

test('command enable reloads config before deriving context; ordinary refresh stays cached', async (t) => {
  const settingsPath = join(agentDir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ minFooter: { enabled: false, contextAsPercentage: false } }));
  const runtime = await installExtension();
  const { ctx, ui } = makeContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx);
  await writeFile(settingsPath, JSON.stringify({ minFooter: { enabled: false, contextAsPercentage: true } }));

  await runtime.commands.get('minfooter').handler('on', ctx);
  assert.match(stripAnsi(ui.component.render(120)[0]), /9\.4%\/128k/);

  await writeFile(settingsPath, JSON.stringify({ minFooter: { enabled: true, contextAsPercentage: false } }));
  await emit(runtime, 'turn_end', ctx);
  assert.match(stripAnsi(ui.component.render(120)[0]), /9\.4%\/128k/, 'ordinary refresh retains cached configuration');
});

test('session restart derives context using reloaded config and new context immediately', async (t) => {
  const settingsPath = join(agentDir, 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ minFooter: { enabled: true, contextAsPercentage: false } }));
  const runtime = await installExtension();
  const first = makeContext();
  const second = makeContext({ usage: { tokens: 12000, contextWindow: 128000 } });
  t.after(async () => {
    await emit(runtime, 'session_shutdown', second.ctx);
    await emit(runtime, 'session_shutdown', first.ctx);
  });
  await start(runtime, first.ctx);
  assert.match(stripAnsi(first.ui.component.render(120)[0]), /12k\/128k/);
  await emit(runtime, 'session_shutdown', first.ctx);

  await writeFile(settingsPath, JSON.stringify({ minFooter: { enabled: true, contextAsPercentage: true } }));
  await start(runtime, second.ctx, 'resume');
  assert.match(stripAnsi(second.ui.component.render(120)[0]), /9\.4%\/128k/);
});

test('event-bus enable reloads configuration before deriving context', async (t) => {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { enabled: false, contextAsPercentage: false } }));
  const bus = createEventBus();
  const runtime = await installExtension(bus);
  const { ctx, ui } = makeContext();
  t.after(() => emit(runtime, 'session_shutdown', ctx));
  await start(runtime, ctx);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { enabled: false, contextAsPercentage: true } }));
  bus.emit('pi-minimal-footer:set-enabled', { enabled: true });
  assert.match(stripAnsi(ui.component.render(120)[0]), /9\.4%\/128k/);
  assert.equal(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')).minFooter.enabled, false, 'event enable remains session-only');
});

test('session hook leaves settings unchanged, respects ownership, and manual commands win', async () => {
  const settingsPath = join(agentDir, 'settings.json');
  const saved = JSON.stringify({ minFooter: { enabled: true } });
  await writeFile(settingsPath, saved);
  const bus = createEventBus();
  const runtime = await installExtension(bus);
  const { ctx, ui } = makeContext();
  const setEnabled = (enabled) => bus.emit('pi-minimal-footer:set-enabled', { enabled });
  await start(runtime, ctx);
  try {
    const first = ui.component;
    setEnabled(true);
    assert.equal(ui.component, first);
    for (const invalid of [null, {}, { enabled: 'false' }, false]) {
      bus.emit('pi-minimal-footer:set-enabled', invalid);
      assert.equal(ui.component, first);
    }
    setEnabled(false);
    assert.equal(ui.component, undefined);
    await emit(runtime, 'model_select', ctx);
    assert.equal(ui.component, undefined);
    assert.equal(await readFile(settingsPath, 'utf8'), saved);
    await runtime.commands.get('minfooter').handler('on', ctx);
    assert.ok(ui.component);
    const replacement = { render: () => ['replacement'] };
    ui.setFooter(() => replacement);
    setEnabled(false);
    assert.equal(ui.component, replacement);
    setEnabled(true);
    assert.notEqual(ui.component, replacement);
    await runtime.commands.get('minfooter').handler('off', ctx);
    assert.equal(ui.component, undefined);
    setEnabled(true);
    assert.ok(ui.component);
    assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).minFooter.enabled, false);
    await start(runtime, ctx, 'switch');
    assert.equal(ui.component, undefined);
  } finally {
    await emit(runtime, 'session_shutdown', ctx);
  }
  setEnabled(true);
  assert.equal(ui.component, undefined);
});

test('session hook ignores events before startup', async () => {
  const settingsPath = join(agentDir, 'settings.json');
  const saved = await readFile(settingsPath, 'utf8');
  const bus = createEventBus();
  const runtime = await installExtension(bus);
  const { ctx, ui } = makeContext();
  bus.emit('pi-minimal-footer:set-enabled', { enabled: false });
  assert.equal(ui.component, undefined);
  assert.equal(await readFile(settingsPath, 'utf8'), saved);
  try {
    await start(runtime, ctx);
    assert.ok(ui.component);
  } finally {
    await emit(runtime, 'session_shutdown', ctx);
  }
});

test('session hook does not install a footer in non-TUI modes', async (t) => {
  for (const mode of ['print', 'json', 'rpc']) {
    const settingsPath = join(agentDir, 'settings.json');
    const saved = await readFile(settingsPath, 'utf8');
    const bus = createEventBus();
    const runtime = await installExtension(bus);
    const { ctx, ui } = makeContext({ mode });
    const setFooter = t.mock.method(ui, 'setFooter');
    try {
      await start(runtime, ctx);
      bus.emit('pi-minimal-footer:set-enabled', { enabled: false });
      bus.emit('pi-minimal-footer:set-enabled', { enabled: true });
      assert.equal(setFooter.mock.callCount(), 0);
      assert.equal(await readFile(settingsPath, 'utf8'), saved);
    } finally {
      await emit(runtime, 'session_shutdown', ctx);
    }
  }
});

test('session hook uses the new context after a session switch', async (t) => {
  const bus = createEventBus();
  const runtime = await installExtension(bus);
  const first = makeContext();
  const second = makeContext({ cwd: join(agentDir, 'other-project') });
  await start(runtime, first.ctx);
  bus.emit('pi-minimal-footer:set-enabled', { enabled: false });
  await emit(runtime, 'session_shutdown', first.ctx);
  const oldSetFooter = t.mock.method(first.ui, 'setFooter');
  try {
    await start(runtime, second.ctx, 'switch');
    assert.ok(second.ui.component, 'new session restores the saved enabled preference');
    bus.emit('pi-minimal-footer:set-enabled', { enabled: false });
    assert.equal(second.ui.component, undefined);
    bus.emit('pi-minimal-footer:set-enabled', { enabled: true });
    assert.ok(second.ui.component);
    assert.equal(oldSetFooter.mock.callCount(), 0);
    assert.equal(first.ui.component, undefined);
  } finally {
    await emit(runtime, 'session_shutdown', second.ctx);
  }
});

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
    assert.match(line, new RegExp(`${Math.round(tokens / 1000)}k/128k`));
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
  oldRenders = 0;
  const currentComponent = ui.factory({ requestRender: () => newRenders++ }, theme, newProvider);
  oldProvider.fire();
  assert.equal(oldRenders, 0, 'superseded callbacks are inert even before disposal');
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
    assert.match(stripAnsi(ui.component.render(120)[0]), /test-model · 12k\/128k/);
    await runtime.commands.get('minfooter').handler('off', ctx);
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(settings.minFooter.enabled, false);
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

test('mode guard leaves rpc/print without a footer while rpc hasUI remains true', async () => {
  const runtime = await installExtension();
  const rpc = makeContext({ mode: 'rpc', hasUI: true });
  await start(runtime, rpc.ctx);
  assert.equal(rpc.ui.factory, undefined);
  const print = makeContext({ mode: 'print', hasUI: false });
  await start(await installExtension(), print.ctx);
  assert.equal(print.ui.factory, undefined);
});
