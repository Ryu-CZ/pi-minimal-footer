import test from 'node:test';
import assert from 'node:assert/strict';
import coverageBadge from '../scripts/coverage-reporter.mjs';

const coverageEvent = (percent, files = [{ path: 'extensions/index.ts' }]) => ({
  type: 'test:coverage',
  data: { summary: { files, totals: { coveredLinePercent: percent } } },
});

async function render(events) {
  let output = '';
  for await (const chunk of coverageBadge(events)) output += chunk;
  return output;
}

test('coverage badge formats the measured percentage and ignores ordinary test events', async () => {
  const svg = await render([{ type: 'test:pass' }, coverageEvent(99.61234)]);
  assert.match(svg, /^<svg /);
  assert.match(svg, /aria-label="Extension line coverage: 99\.61%"/);
  assert.match(svg, /<text x="97.5" y="14">99\.61%<\/text>/);
  assert.equal((svg.match(/<svg /g) ?? []).length, 1);
});

test('coverage badge colors follow coverage thresholds, including zero coverage', async () => {
  for (const [percent, color] of [[100, '#4c1'], [90, '#4c1'], [89.99, '#97ca00'], [80, '#97ca00'], [79.99, '#dfb317'], [70, '#dfb317'], [69.99, '#e05d44'], [0, '#e05d44']]) {
    const svg = await render([coverageEvent(percent)]);
    assert.ok(svg.includes(`fill="${color}"`), `coverage=${percent}`);
    assert.ok(svg.includes(`${percent.toFixed(2)}%`));
  }
});

test('coverage badge rejects an empty source report instead of claiming full coverage', async () => {
  await assert.rejects(render([coverageEvent(100, [])]), /No extension source files/);
});
