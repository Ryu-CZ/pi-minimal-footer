import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { agentDir, makeContext, installExtension, start, emit, visibleWidth, stripAnsi } from './helpers/footer-fixture.mjs';
const jiti = createJiti(import.meta.url);
const { CompactEditor, CompactEditorController } = await jiti.import('../extensions/lib/compact-editor.ts');
const { buildLine } = await jiti.import('../extensions/lib/footer-layout.ts');
const plain = s => s;
const editorTheme = { borderColor: s => `\x1b[31m${s}\x1b[0m`, selectList: {
  selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain,
} };
const tui = { terminal: { rows: 30 }, requestRender() {} };
const keys = { matches: () => false };

async function compactFixture() {
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { compactEditor: true, showUsage: false, showGitBranch: false } }));
  const runtime = await installExtension();
  const fixture = makeContext();
  return { runtime, ...fixture };
}

test('compact only overlays bottom separator with cell-safe content', () => {
  assert.equal(CompactEditor.prototype.render, CustomEditor.prototype.render);
  assert.equal(CompactEditor.prototype.handleInput, CustomEditor.prototype.handleInput);
  assert.equal(CompactEditor.prototype.setAutocompleteProvider, CustomEditor.prototype.setAutocompleteProvider);
  for (const text of ['', '\x1b[32m技能 ✅ 👨‍👩‍👧‍👦\x1b[0m', 'x'.repeat(200)]) {
    const normal = new CustomEditor(tui, editorTheme, keys, { embedWorkingStatus: true });
    const compact = new CompactEditor(tui, editorTheme, keys, { embedWorkingStatus: true }, () => text);
    normal.setText('draft 技能\nsecond line');
    compact.setText('draft 技能\nsecond line');
    assert.equal(compact.embedWorkingStatus, true);
    for (const width of [1, 10, 40, 80, 120]) {
      const border = compact.renderBottomBorder(width, 0);
      assert.equal(visibleWidth(border), width);
      assert.ok(border.startsWith(truncateToWidth(text, width, '')), `overlay missing at width ${width}`);
      if (text === '') assert.equal(border, normal.renderBottomBorder(width, 0));
      assert.equal(compact.renderBottomBorder(width, 3), normal.renderBottomBorder(width, 3));
      // Pi 1.0.3's own word wrapper recurses on wide input at width one.
      if (width > 1) assert.deepEqual(compact.render(width).slice(0, -1), normal.render(width).slice(0, -1));
    }
  }
});

test('compact layout embeds groups in a rule without changing text spaces or normal padding', () => {
  const parts = {
    path: '~/git/project', branch: ' main', statuses: '', model: 'gpt-6-sol', context: '12k/256k',
    usage: () => null, statusSeparator: '  ', locationSeparator: '  ', maxUsageBarCells: 10,
  };
  const compact = buildLine({ ...parts, width: 80, borderColor: editorTheme.borderColor });
  assert.match(stripAnsi(compact), /^─ ~\/git\/project   main ─+ gpt-6-sol · 12k\/256k ─$/);
  assert.ok(compact.startsWith(editorTheme.borderColor('─') + ' '));
  assert.ok(compact.endsWith(' ' + editorTheme.borderColor('─')));
  const normal = buildLine({ ...parts, width: 80 });
  assert.match(normal, /^ ~\/git\/project   main +gpt-6-sol · 12k\/256k $/);
  assert.doesNotMatch(normal, /─/);
  for (const overrides of [{}, { path: '', branch: '' }, { model: '', context: '' },
    { path: '', branch: '', model: '', context: '' },
    { path: '\x1b[32m技能 ✅\x1b[0m', model: '模型 👨‍👩‍👧‍👦' },
    { usage: () => '[⣿⣤⠀⠀]↻16:40' }]) {
    // Real usage renderers honor the available width, including the reset-only fallback.
    const usage = overrides.usage;
    const options = { ...parts, ...overrides, ...(usage && { usage: available => available >= 14 ? usage() : null }) };
    for (let width = 0; width <= 120; width++) {
      const line = buildLine({ ...options, width, borderColor: editorTheme.borderColor });
      assert.equal(visibleWidth(line), width, `width=${width}, ${JSON.stringify(overrides)}`);
      if (width > 0) {
        assert.ok(stripAnsi(line).startsWith('─'));
        assert.ok(stripAnsi(line).endsWith('─'));
      }
    }
  }
});

test('one remaining gap column cannot become two compact separator spaces', () => {
  const line = buildLine({
    width: 40, path: 'path', branch: 'main', statuses: '', model: 'm', context: '',
    // This expanded usage leaves only one column between the final groups.
    usage: (_available, maxCells) => maxCells === 2 ? '[]' : 'x'.repeat(20),
    statusSeparator: ' | ', locationSeparator: ' / ', maxUsageBarCells: 10,
    borderColor: editorTheme.borderColor,
  });
  assert.equal(visibleWidth(line), 40);
  assert.equal(stripAnsi(line), '─ path / main m · ' + 'x'.repeat(20) + ' ─');
});

test('autocomplete rows remain identical below the separator', async () => {
  const normal = new CustomEditor(tui, editorTheme, keys);
  const compact = new CompactEditor(tui, editorTheme, keys, { embedWorkingStatus: true }, () => 'footer');
  const provider = {
    triggerCharacters: ['/'],
    getSuggestions: async () => ({ items: [{ value: '/foo', label: 'foo', description: 'completion' }], prefix: '/' }),
    applyCompletion: () => ({ lines: ['/foo'], cursorLine: 0, cursorCol: 4 }),
  };
  for (const editor of [normal, compact]) {
    editor.setAutocompleteProvider(provider);
    editor.handleInput('/');
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(normal.isShowingAutocomplete(), true);
  assert.equal(compact.isShowingAutocomplete(), true);
  for (const width of [10, 40, 80, 120]) {
    const original = normal.render(width);
    const actual = compact.render(width);
    assert.equal(actual.length, original.length);
    // One input row is bracketed by the top and bottom borders; completions follow.
    assert.deepEqual(actual.slice(0, 2), original.slice(0, 2));
    assert.deepEqual(actual.slice(3), original.slice(3));
  }
});

test('owned swaps preserve real collapsed paste contents across editor instances', () => {
  let editor = new CustomEditor(tui, editorTheme, keys);
  let factory;
  const ui = {
    getEditorComponent: () => factory,
    getEditorText: () => editor.getExpandedText(),
    setEditorText: text => editor.setText(text),
    setEditorComponent(next) {
      // Match Pi's swap: it transfers marker text, not the private paste store.
      const text = editor.getText();
      editor = next ? next(tui, editorTheme, keys) : new CustomEditor(tui, editorTheme, keys);
      editor.setText(text);
      factory = next;
    },
  };
  const controller = new CompactEditorController();
  const draft = 'pasted 技能 ✅\n'.repeat(40);
  const paste = () => {
    editor.setText('');
    editor.handleInput(`\x1b[200~${draft}\x1b[201~`);
    assert.notEqual(editor.getText(), draft, 'real editor collapsed the paste');
    assert.equal(editor.getExpandedText(), draft);
  };
  paste();
  controller.install(ui, () => 'footer');
  assert.equal(controller.isActive(), true);
  assert.equal(ui.getEditorText(), draft);
  paste();
  controller.dispose();
  assert.equal(controller.isActive(), false);
  assert.equal(factory, undefined);
  assert.equal(ui.getEditorText(), draft);
  controller.dispose();
});

test('compact owns zero footer rows and preserves expanded draft through swaps and shutdown', async () => {
  const { runtime, ctx, ui } = await compactFixture();
  const draft = 'pasted\n'.repeat(30);
  ui.collapsePaste(draft);
  await start(runtime, ctx);
  assert.deepEqual(ui.component.render(80), []);
  assert.equal(ui.getEditorText(), draft);
  const factory = ui.getEditorComponent();
  const editor = factory(tui, editorTheme, keys);
  const original = new CustomEditor(tui, editorTheme, keys);
  assert.match(stripAnsi(editor.renderBottomBorder(80, 0)), /^─ .*test-model · 12k\/128k ─$/);
  assert.ok(editor.renderBottomBorder(80, 0).startsWith(editorTheme.borderColor('─') + ' '));
  editor.borderColor = text => `\x1b[35m${text}\x1b[0m`;
  const recolored = editor.renderBottomBorder(80, 0);
  assert.ok(recolored.startsWith(editor.borderColor('─') + ' '), 'uses the live Pi separator color, not a captured theme color');
  assert.ok(recolored.includes(' ' + editor.borderColor('─')), JSON.stringify(recolored.slice(-60)));
  await start(runtime, ctx);
  assert.equal(ui.getEditorComponent(), factory);
  assert.equal(ui.editorSwaps, 1);
  ui.collapsePaste(draft);
  await emit(runtime, 'session_shutdown', ctx);
  assert.equal(ui.getEditorComponent(), undefined);
  assert.equal(ui.getEditorText(), draft);
  ui.component.dispose();
  assert.equal(ui.editorSwaps, 2);
  original.borderColor = editor.borderColor;
  assert.equal(editor.renderBottomBorder(80, 0), original.renderBottomBorder(80, 0), 'disposed callback leaves the original separator');
});

test('existing custom editor refused; later takeover falls back without reclaiming', async () => {
  for (const existing of [true, false]) {
    const { runtime, ctx, ui } = await compactFixture();
    const other = () => {};
    if (existing) ui.setEditorComponent(other);
    await start(runtime, ctx);
    if (!existing) {
      assert.deepEqual(ui.component.render(80), [], 'compact owned the editor before takeover');
      ui.setEditorComponent(other);
    }
    assert.equal(ui.component.render(80).length, 1);
    assert.match(stripAnsi(ui.component.render(80)[0]), /test-model · 12k\/128k/);
    await start(runtime, ctx);
    assert.equal(ui.getEditorComponent(), other);
    assert.equal(ui.component.render(80).length, 1);
    await emit(runtime, 'session_shutdown', ctx);
    assert.equal(ui.getEditorComponent(), other);
  }
});

test('footer replacement releases compact and passive refresh never reinstalls it', async () => {
  const { runtime, ctx, ui } = await compactFixture();
  await start(runtime, ctx);
  const old = ui.component;
  ui.collapsePaste('retained full draft');
  ui.setFooter(() => ({ render: () => ['other'], invalidate() {} }));
  assert.equal(ui.getEditorComponent(), undefined);
  assert.equal(ui.getEditorText(), 'retained full draft');
  const swaps = ui.editorSwaps;
  await emit(runtime, 'model_select', ctx);
  await emit(runtime, 'agent_settled', ctx);
  old.dispose();
  old.dispose();
  assert.equal(ui.editorSwaps, swaps);
  assert.deepEqual(ui.component.render(80), ['other']);
  await emit(runtime, 'session_shutdown', ctx);
});

test('compact setting changes restore and reinstall without redundant swaps', async () => {
  const { runtime, ctx, ui } = await compactFixture();
  await start(runtime, ctx);
  for (const compact of [false, true, true]) {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { compactEditor: compact, showUsage: false } }));
    ui.collapsePaste('expanded draft');
    await runtime.commands.get('minfooter').handler('on', ctx);
    assert.equal(ui.component.render(80).length, compact ? 0 : 1);
    assert.equal(ui.getEditorText(), 'expanded draft');
  }
  assert.equal(ui.editorSwaps, 3);
  await emit(runtime, 'session_shutdown', ctx);
});

test('toggle off restores owned editor and expanded paste without restarting on passive events', async () => {
  const { runtime, ctx, ui } = await compactFixture();
  await start(runtime, ctx);
  ui.collapsePaste('full paste\n'.repeat(40));
  await runtime.commands.get('minfooter').handler('off', ctx);
  assert.equal(ui.getEditorComponent(), undefined);
  assert.equal(ui.getEditorText(), 'full paste\n'.repeat(40));
  const swaps = ui.editorSwaps;
  await emit(runtime, 'model_select', ctx);
  assert.equal(ui.editorSwaps, swaps);
  await emit(runtime, 'session_shutdown', ctx);
});
