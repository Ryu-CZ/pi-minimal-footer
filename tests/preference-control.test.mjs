import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentDir, createEventBus, makeContext, codexContext, fakeUsageFetch,
  installExtension, start, emit, settle, stripAnsi,
} from './helpers/footer-fixture.mjs';

const editorTheme = { borderColor: text => text, selectList: {} };
const editorTui = { terminal: { rows: 30 }, requestRender() {} };
const keybindings = { matches: () => false };
const usageBar = /\[[⠀⡀⣀⣄⣤⣦⣶⣷⣿]+\]/;

function statusLine(ui) {
  const rows = ui.component.render(120);
  if (rows.length) return stripAnsi(rows[0]);
  const editor = ui.getEditorComponent()(editorTui, editorTheme, keybindings);
  return stripAnsi(editor.renderBottomBorder(120, 0));
}

for (const compact of [false, true]) {
  const mode = compact ? 'compact' : 'normal';

  test(`${mode}: programmatic footer control preserves preferences, drafts and competing ownership`, async (t) => {
    const path = join(agentDir, 'settings.json');
    const saved = JSON.stringify({ minFooter: { compactEditor: compact, showUsage: false } });
    await writeFile(path, saved);
    const bus = createEventBus();
    const runtime = await installExtension(bus);
    const { ctx, ui } = makeContext();
    t.after(() => emit(runtime, 'session_shutdown', ctx));
    const enabled = value => bus.emit('pi-minimal-footer:set-enabled', { enabled: value });

    enabled(false);
    await start(runtime, ctx);
    assert.match(statusLine(ui), /test-model · 12k\/128k/);
    assert.equal(ui.component.render(120).length, compact ? 0 : 1);
    const component = ui.component;
    const swaps = ui.editorSwaps;
    enabled(true);
    for (const invalid of [null, {}, { enabled: 'false' }, false]) {
      bus.emit('pi-minimal-footer:set-enabled', invalid);
    }
    assert.equal(ui.component, component);
    assert.equal(ui.editorSwaps, swaps);

    ui.collapsePaste('full draft\n'.repeat(30));
    enabled(false);
    assert.equal(ui.component, undefined);
    assert.equal(ui.getEditorComponent(), undefined);
    assert.equal(ui.getEditorText(), 'full draft\n'.repeat(30));
    await emit(runtime, 'model_select', ctx);
    assert.equal(ui.component, undefined);
    enabled(true);
    assert.equal(ui.component.render(120).length, compact ? 0 : 1);
    assert.match(statusLine(ui), /test-model · 12k\/128k/);
    enabled(false);
    await start(runtime, ctx, 'reload');
    assert.equal(ui.component.render(120).length, compact ? 0 : 1, 'session start restores the saved enabled preference');

    const otherEditor = () => {};
    ui.setEditorComponent(otherEditor);
    ui.setFooter(() => ({ render: () => ['other footer'] }));
    enabled(false);
    assert.deepEqual(ui.component.render(120), ['other footer']);
    assert.equal(ui.getEditorComponent(), otherEditor);
    enabled(true);
    assert.equal(ui.getEditorComponent(), otherEditor);
    assert.equal(ui.component.render(120).length, 1, 'custom editor forces normal-row fallback');
    assert.match(statusLine(ui), /test-model · 12k\/128k/);
    assert.equal(await readFile(path, 'utf8'), saved);
  });

  for (const savedUsage of [false, true]) {
    test(`${mode}: usage override supports true/false/null with saved ${savedUsage}`, async (t) => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1791200000000 });
      const path = join(agentDir, 'settings.json');
      const saved = JSON.stringify({ unrelated: 42, minFooter: { compactEditor: compact, showUsage: savedUsage } });
      await writeFile(path, saved);
      const calls = fakeUsageFetch(t);
      const bus = createEventBus();
      const runtime = await installExtension(bus);
      const { ctx, ui } = codexContext();
      t.after(() => emit(runtime, 'session_shutdown', ctx));
      const usage = value => bus.emit('pi-minimal-footer:set-usage-enabled', { enabled: value });
      const enabled = value => bus.emit('pi-minimal-footer:set-enabled', { enabled: value });
      usage(!savedUsage);
      await start(runtime, ctx);
      await settle();
      assert.equal(usageBar.test(statusLine(ui)), savedUsage);
      assert.equal(calls.length, savedUsage ? 1 : 0);
      const component = ui.component;
      const editorFactory = ui.getEditorComponent();
      const swaps = ui.editorSwaps;

      usage(true);
      await settle();
      assert.match(statusLine(ui), usageBar);
      const beforeNoop = calls.length;
      usage(true);
      for (const invalid of [null, {}, { enabled: 'false' }, { enabled: 0 }]) {
        bus.emit('pi-minimal-footer:set-usage-enabled', invalid);
      }
      await settle();
      assert.equal(calls.length, beforeNoop);
      assert.equal(ui.component, component);
      assert.equal(ui.getEditorComponent(), editorFactory);
      assert.equal(ui.editorSwaps, swaps);

      usage(false);
      assert.doesNotMatch(statusLine(ui), usageBar);
      const beforeSuppression = calls.length;
      await emit(runtime, 'model_select', ctx);
      t.mock.timers.tick(480000);
      await settle();
      assert.equal(calls.length, beforeSuppression);
      enabled(false);
      usage(true);
      await settle();
      assert.equal(calls.length, beforeSuppression, 'usage override cannot poll while the footer is disabled');
      usage(false);
      enabled(true);
      await settle();
      assert.doesNotMatch(statusLine(ui), usageBar);
      assert.equal(calls.length, beforeSuppression, 'footer reinstallation preserves usage suppression');
      assert.equal(ui.component.render(120).length, compact ? 0 : 1);

      usage(null);
      await settle();
      assert.equal(usageBar.test(statusLine(ui)), savedUsage, 'null restores the saved preference');
      usage(true);
      await settle();
      assert.match(statusLine(ui), usageBar);
      await start(runtime, ctx, 'reload');
      await settle();
      assert.equal(usageBar.test(statusLine(ui)), savedUsage, 'session start clears the override');
      await emit(runtime, 'session_shutdown', ctx);
      const beforeShutdownEvent = calls.length;
      usage(true);
      t.mock.timers.tick(480000);
      await settle();
      assert.equal(calls.length, beforeShutdownEvent);
      assert.equal(await readFile(path, 'utf8'), saved, 'programmatic controls never persist settings');
    });
  }
}
