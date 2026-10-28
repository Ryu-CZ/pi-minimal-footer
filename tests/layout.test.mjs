import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentDir, homeDir, visibleWidth, theme, makeContext, provider, stripAnsi, settle, usagePayload, codexContext, fakeUsageFetch, installExtension, start, emit } from './helpers/footer-fixture.mjs';

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
    assert.match(stripAnsi(ui.component.render(36)[0]), /^ test-model · 12k\/128k · \[⣶⠀\]↻\d\d:\d\d $/);
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
  assert.match(stripAnsi(ui.component.render(120)[0]), /test-model · 12k\/128k · \[[⠀⡀⣀⣄⣤⣦⣶⣷⣿]+\]/);
  await emit(runtime, 'session_shutdown', ctx);
});

test('extension statuses are individual power tabs without footer-added wrappers', async () => {
  const runtime = await installExtension();
  const { ctx, ui } = makeContext({ footerProvider: provider(new Map([['a', '🧠 Karpathy'], ['b', '🪽 Icarus'], ['empty', ' ']])) });
  await start(runtime, ctx);
  const line = stripAnsi(ui.component.render(160)[0]);
  assert.ok(line.includes(' 🧠 Karpathy  🪽 Icarus  test-model · 12k/128k'), line);
  assert.doesNotMatch(line, /[()|]/);
  for (let width = 0; width <= 160; width++) assert.ok(visibleWidth(ui.component.render(width)[0]) <= width, `width=${width}`);
  await emit(runtime, 'session_shutdown', ctx);
});

test('extension statuses normalize line breaks and tabs without losing ANSI styling', async () => {
  const runtime = await installExtension();
  const { ctx, ui } = makeContext({ footerProvider: provider(new Map([['a', '\u001b[32mfirst\nsecond\tthird\rfourth\u001b[0m']])) });
  await start(runtime, ctx);
  const lines = ui.component.render(180);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /[\r\n\t]/);
  assert.match(stripAnsi(lines[0]), /first second third fourth/);
  assert.ok(lines[0].includes('\u001b[32m'));
  await emit(runtime, 'session_shutdown', ctx);
});

test('compact model separators and optional plain-space status fallback', async () => {
  for (const powerlineSeparator of [true, false]) {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { powerlineSeparator } }));
    const runtime = await installExtension();
    const { ctx, ui } = makeContext({ footerProvider: provider(new Map([['a', 'status']])) });
    await start(runtime, ctx);
    const line = stripAnsi(ui.component.render(120)[0]);
    assert.ok(line.includes(`${powerlineSeparator ? '  ' : ' '}status${powerlineSeparator ? '  ' : ' '}test-model · 12k/128k`));
    assert.match(line, /test-model · 12k\/128k/);
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
  assert.match(stripAnsi(wide), /^ ~\/project\/child   main + 技能 ✅  long status text  模型-red · 12k\/128k $/);
  assert.deepEqual(boldCalls.slice(-2), ['模型\u001b[31m-red\u001b[0m', '12k/128k'], 'model/context retain bold theme styling');
  assert.match(wide, /\u001b\[1m/);
  assert.equal(visibleWidth(wide), 160, 'normal layout right-aligns and fills the available width');
  const medium = stripAnsi(component.render(45)[0]);
  assert.doesNotMatch(medium, /long status text/, 'long statuses shorten before git');
  assert.match(medium, / 技能 .*\.\.\./);
  assert.match(medium, / main/);
  assert.match(medium, /模型/);
  assert.equal(visibleWidth(medium), 45, 'status-drop layout remains right-aligned');
  assert.match(medium, /^  main + .*  模型/);
  assert.match(medium, /12k\/128k $/);
  const narrow = stripAnsi(component.render(20)[0]);
  assert.doesNotMatch(narrow, /|技能|long status/, 'git drops before model/context');
  assert.match(narrow, /模型/);
  assert.equal(visibleWidth(narrow), 20, 'branch-drop layout remains right-aligned');
  assert.match(narrow, /^ +/);
  assert.match(narrow, /12k\/128k $/);
  assert.ok(visibleWidth(component.render(5)[0]) <= 5);
});

test('each disabled feature option omits only its segment', async () => {
  for (const [key, forbidden] of [['showPath', '/project'], ['showSkills', '技能'], ['showGitBranch', 'main'], ['showModel', 'test-model'], ['showContext', '12k/128k']]) {
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ minFooter: { enabled: true, [key]: false } }));
    const runtime = await installExtension();
    const { ctx, ui } = makeContext({ cwd: join(homeDir, 'project'), footerProvider: provider() });
    await start(runtime, ctx);
    assert.doesNotMatch(stripAnsi(ui.component.render(160)[0]), new RegExp(forbidden.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')), key);
  }
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
  assert.match(lines[0], /test-model · 12k\/128k · \[⣿{3}⣤⠀{6}\]↻16:40 $/);
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
  assert.match(narrow, /12k\/128k · \[⣶⠀\]↻16:40 $/);
  assert.doesNotMatch(narrow, /project|技能|/);
  assert.match(stripAnsi(ui.component.render(10)[0]), /↻16:40 $/);
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
