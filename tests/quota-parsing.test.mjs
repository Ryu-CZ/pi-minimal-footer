import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const { parseUsage, parseUsageWindows } = await jiti.import('../extensions/lib/quota-providers.ts');

test('Kimi used-only weekly counts accept numeric strings and zero', () => {
  assert.equal(parseUsage('kimi-coding', '', { usage: { limit: '100', used: '40' } }).used, 40);
  assert.equal(parseUsage('kimi-coding', '', { usage: { limit: 100, used: 0 } }).used, 0);
});

test('Kimi explicit used takes precedence over remaining', () => {
  assert.equal(parseUsage('kimi-coding', '', { usage: { limit: 100, used: 40, remaining: 5 } }).used, 40);
});

test('Kimi rolling snapshots have stable duration identities and week/month ordering', () => {
  const payload = { limits: [
    { window: { duration: '1', timeUnit: 'TIME_UNIT_MONTH' }, detail: { limit: '100', used: '90' } },
    { window: { duration: 1, timeUnit: 'TIME_UNIT_WEEK' }, detail: { limit: 100, used: 70 } },
    { window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, used: 35 } },
  ], usage: { limit: 100, remaining: 60 } };
  const windows = parseUsageWindows('kimi-coding', '', payload);
  assert.deepEqual(Object.keys(windows), ['1:TIME_UNIT_MONTH', '1:TIME_UNIT_WEEK', '5:TIME_UNIT_HOUR', 'weekly']);
  assert.equal(windows['1:TIME_UNIT_MONTH'].seconds, 2592000);
  assert.equal(windows['1:TIME_UNIT_WEEK'].seconds, 604800);
  assert.equal(parseUsage('kimi-coding', '', payload).used, 35);
});

test('Kimi retains second/minute/hour/day conversions', () => {
  for (const [unit, seconds] of [['SECOND', 2], ['MINUTE', 120], ['HOUR', 7200], ['DAY', 172800]]) {
    const result = parseUsage('kimi-coding', '', { limits: [{ window: { duration: 2, timeUnit: `TIME_UNIT_${unit}` }, detail: { limit: 10, remaining: 7 } }] });
    assert.equal(result.seconds, seconds);
    assert.equal(result.used, 30);
  }
});

test('Kimi rejects nonpositive limits and invalid or out-of-range counts', () => {
  for (const usage of [{ limit: 0, used: 0 }, { limit: -1, used: 0 }, { limit: 100, used: -1 }, { limit: 100, used: 101 }, { limit: 100, used: 'invalid' }, { limit: 100, remaining: 101 }, { limit: 100, remaining: -1 }]) {
    assert.throws(() => parseUsage('kimi-coding', '', { usage }));
  }
});

test('Codex numeric strings and relative reset fallback use the controlled clock', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1791200000000 });
  const result = parseUsage('openai-codex', '', { rate_limit: { primary_window: { used_percent: '35', limit_window_seconds: '18000', reset_after_seconds: '3600' } } });
  assert.deepEqual(result, { used: 35, seconds: 18000, resetAt: 1791203600000 });
  for (const reset_at of [undefined, 'invalid', -1]) {
    assert.equal(parseUsage('openai-codex', '', { rate_limit: { primary_window: { used_percent: 0, reset_at, reset_after_seconds: 0 } } }).resetAt, 1791200000000);
  }
});

test('Codex valid absolute reset wins over relative delay', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1791200000000 });
  assert.equal(parseUsage('openai-codex', '', { rate_limit: { primary_window: { used_percent: 35, reset_at: '1791207200', reset_after_seconds: 3600 } } }).resetAt, 1791207200000);
  assert.equal(parseUsage('openai-codex', '', { rate_limit: { primary_window: { used_percent: 35, reset_after_seconds: -1 } } }).resetAt, null);
});

test('malformed optional resets preserve required valid usage', () => {
  const cases = [
    ['openai-codex', { rate_limit: { primary_window: { used_percent: 35, reset_at: 'invalid' } } }],
    ['anthropic', { five_hour: { utilization: 35, resets_at: 'invalid' } }],
    ['minimax', { model_remains: [{ current_interval_remaining_percent: 65, end_time: 'invalid' }] }],
    ['minimax-cn', { model_remains: [{ current_interval_remaining_percent: 65, end_time: 'invalid' }] }],
    ['kimi-coding', { usage: { limit: 100, used: 35, resetTime: 'invalid' } }],
    ['opencode-go', { rollingUsage: { usagePercent: 35, resetInSec: -1 } }],
    ['github-copilot', { quota_snapshots: { chat: { percent_remaining: 65 } }, quota_reset_date_utc: 'invalid' }],
    ['google-gemini-cli', { buckets: [{ modelId: 'gemini-pro', remainingFraction: 0.65, resetTime: 'invalid' }] }],
  ];
  for (const [provider, payload] of cases) {
    const result = parseUsage(provider, 'gemini-pro', payload);
    assert.equal(Math.round(result.used), 35, provider);
    assert.equal(result.resetAt, null, provider);
  }
});

test('all providers distinguish recognized absence from malformed snapshots', () => {
  const cases = [
    ['openai-codex', { rate_limit: null }, { rate_limit: { primary_window: { used_percent: null } } }],
    ['anthropic', { five_hour: null, seven_day: null }, { five_hour: { utilization: null }, seven_day: null }],
    ['minimax', { model_remains: [] }, { model_remains: [{ current_interval_remaining_percent: null }] }],
    ['minimax-cn', { model_remains: [] }, { model_remains: [{ current_interval_remaining_percent: null }] }],
    ['kimi-coding', { limits: [], usage: null }, { limits: [], usage: { limit: 100 } }],
    ['opencode-go', { rollingUsage: null }, { rollingUsage: { usagePercent: null }, weeklyUsage: null }],
    ['github-copilot', { quota_snapshots: {} }, { quota_snapshots: { chat: { percent_remaining: null }, premium_interactions: { unlimited: true } } }],
    ['google-gemini-cli', { buckets: [] }, { buckets: [{ modelId: 'gemini-pro', remainingFraction: null }] }],
  ];
  for (const [provider, absent, malformed] of cases) {
    assert.equal(parseUsage(provider, 'gemini-pro', absent), null, provider);
    assert.throws(() => parseUsage(provider, 'gemini-pro', malformed), provider);
    assert.throws(() => parseUsage(provider, 'gemini-pro', { error: { message: 'unexpected response' } }), provider);
    assert.throws(() => parseUsage(provider, 'gemini-pro', {}), provider);
  }
});

test('malformed explicit durations cannot win shortest-window selection', () => {
  for (const duration of [0, -1, 'invalid']) {
    const payload = { rate_limit: { primary_window: { used_percent: 35, limit_window_seconds: duration }, secondary_window: { used_percent: 90, limit_window_seconds: 604800 } } };
    assert.equal(parseUsage('openai-codex', '', payload).used, 90);
    assert.deepEqual(Object.keys(parseUsageWindows('openai-codex', '', payload)), ['secondary']);
  }
  const payload = { limits: [{ window: { duration: 1, timeUnit: 'INVALID' }, detail: { limit: 100, used: 35 } }], usage: { limit: 100, used: 90 } };
  assert.deepEqual(Object.keys(parseUsageWindows('kimi-coding', '', payload)), ['weekly']);
  assert.equal(parseUsage('kimi-coding', '', payload).used, 90);
});

test('full snapshots retain all valid siblings under stable provider-local keys', () => {
  const cases = [
    ['openai-codex', { rate_limit: { primary_window: { used_percent: 35 }, secondary_window: { used_percent: 90 } } }, ['primary', 'secondary']],
    ['anthropic', { five_hour: { utilization: 35 }, seven_day: { utilization: 90 } }, ['five_hour', 'seven_day']],
    ['minimax', { model_remains: [{ current_interval_remaining_percent: 65, current_weekly_remaining_percent: 10 }] }, ['interval', 'weekly']],
    ['minimax-cn', { model_remains: [{ current_interval_remaining_percent: 65, current_weekly_remaining_percent: 10 }] }, ['interval', 'weekly']],
    ['opencode-go', { rollingUsage: { usagePercent: 35 }, weeklyUsage: { usagePercent: 90 }, monthlyUsage: { usagePercent: 95 } }, ['rollingUsage', 'weeklyUsage', 'monthlyUsage']],
    ['github-copilot', { quota_snapshots: { premium_interactions: { percent_remaining: 65 }, chat: { percent_remaining: 10 } } }, ['premium_interactions', 'chat']],
    ['google-gemini-cli', { buckets: [{ modelId: 'gemini-pro', tokenType: 'INPUT', remainingFraction: 0.65 }, { modelId: 'gemini-pro', tokenType: 'OUTPUT', remainingFraction: 0.1 }] }, ['gemini-pro:INPUT', 'gemini-pro:OUTPUT']],
  ];
  for (const [provider, payload, keys] of cases) assert.deepEqual(Object.keys(parseUsageWindows(provider, 'gemini-pro', payload)), keys, provider);
});

test('valid sibling windows survive malformed usage', () => {
  const cases = [
    ['anthropic', { five_hour: { utilization: null }, seven_day: { utilization: 90 } }, 'seven_day'],
    ['minimax', { model_remains: [{ current_interval_remaining_percent: null, current_weekly_remaining_percent: 10 }] }, 'weekly'],
    ['kimi-coding', { limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 0, used: 0 } }], usage: { limit: 100, used: 90 } }, 'weekly'],
    ['opencode-go', { rollingUsage: { usagePercent: null }, weeklyUsage: { usagePercent: 90 } }, 'weeklyUsage'],
    ['github-copilot', { quota_snapshots: { premium_interactions: { percent_remaining: null }, chat: { percent_remaining: 10 } } }, 'chat'],
    ['google-gemini-cli', { buckets: [{ modelId: 'gemini-pro', tokenType: 'INPUT', remainingFraction: null }, { modelId: 'gemini-pro', tokenType: 'OUTPUT', remainingFraction: 0.1 }] }, 'gemini-pro:OUTPUT'],
  ];
  for (const [provider, payload, key] of cases) {
    const windows = parseUsageWindows(provider, 'gemini-pro', payload);
    assert.deepEqual(Object.keys(windows), [key], provider);
    assert.equal(Math.round(windows[key].used), 90, provider);
  }
});

test('Copilot unlimited and Gemini recognizable nonmatching buckets are absent', () => {
  assert.equal(parseUsage('github-copilot', '', { quota_snapshots: { chat: { unlimited: true } } }), null);
  assert.equal(parseUsage('google-gemini-cli', 'gemini-pro', { buckets: [{ modelId: 'gemini-flash', remainingFraction: 0.5 }] }), null);
  assert.throws(() => parseUsage('google-gemini-cli', 'gemini-pro', { buckets: [{}] }));
  assert.throws(() => parseUsage('google-gemini-cli', 'gemini-pro', { buckets: [{ modelId: 'gemini-flash', remainingFraction: null }] }));
});

test('Gemini malformed exact-model usage cannot substitute a different family model', () => {
  assert.throws(() => parseUsage('google-gemini-cli', 'gemini-pro', { buckets: [
    { modelId: 'gemini-pro', remainingFraction: null },
    { modelId: 'gemini-pro-other', remainingFraction: 0.5 },
  ] }));
});

test('malformed snapshot containers do not become usable named windows', () => {
  for (const [provider, payload] of [
    ['openai-codex', { rate_limit: 'invalid' }],
    ['minimax', { model_remains: {} }],
    ['kimi-coding', { limits: {} }],
    ['github-copilot', { quota_snapshots: [{ percent_remaining: 65 }] }],
    ['google-gemini-cli', { buckets: {} }],
  ]) assert.throws(() => parseUsage(provider, 'gemini-pro', payload), provider);
});

test('Kimi null rolling entries are malformed while empty snapshots remain absent', () => {
  assert.throws(() => parseUsageWindows('kimi-coding', '', { limits: [null] }));
  assert.throws(() => parseUsageWindows('kimi-coding', '', { limits: [null], usage: null }));
  assert.equal(parseUsageWindows('kimi-coding', '', { limits: [], usage: null }), null);
  const valid = { window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, used: 35 } };
  assert.deepEqual(parseUsageWindows('kimi-coding', '', { limits: [null, valid] }), {
    '5:TIME_UNIT_HOUR': { used: 35, seconds: 18000, resetAt: null },
  });
});
