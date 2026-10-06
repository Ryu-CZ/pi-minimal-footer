# Quota Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Track completion with checkboxes.

**Goal:** Fix the five reproduced quota bugs while retaining the approved minimal footer.

**Execution note:** The user requested main-thread takeover after Task 2 reached initial GREEN. The controller stopped delegation, reviewed the combined implementation directly, updated documentation, and ran final verification. A later final review removed the unused parser, simplified header/layout expressions, and added missing-credential removal/recovery coverage. The user subsequently authorized a commit; publication remains outside scope.

**Architecture:** Provider parsers expose all valid windows with stable provider-local keys and distinguish explicit absence from malformed payloads. The lifecycle controller replaces windows on full snapshots, merges partial passive updates, selects the shortest cached window, and bounds authentication independently of its underlying promise.

**Tech Stack:** TypeScript, Pi 1.0.3 extension APIs, Node test runner, existing real-extension-loader fixtures.

**Spec:** The user-approved footer requirements and comparison findings reproduced in this conversation; the binding requirements are written below.

## Global Constraints

- Display only the selected provider, its shortest available quota (including weekly/monthly fallback), five bottom-up Braille cells, and optional local 24-hour `↻HH:mm` reset time.
- Preserve the existing layout, colors, provider-switch cancellation, redirect rejection, origin checks, unknown-reset bar-only display, and four-minute fallback interval.
- Explicit no limits, unlimited quotas, unsupported/local providers, and unavailable credentials hide the quota. Malformed responses and transient failures preserve dim cached data.
- No paid model probes, dashboard-cookie setup, new dependencies, version bumps, commits, publication, or changes to unrelated pre-existing work.
- Work in the current checkout, with only one implementation agent editing at a time. Preserve the pre-existing uncommitted usage feature.
- Workers do not spawn additional agents. Controller owns review and integration.

## Review Focus

- Authentication never settles: release the request slot and schedule another attempt after timeout; ignore late credential resolution.
- A partial weekly response must not displace a cached shorter quota or indefinitely defer its refresh.
- Provider switching during timed-out auth or JSON reads must never restore the old provider's data.
- Malformed optional reset metadata must leave valid usage visible without a reset time; unusable payloads must retain dim cached data.
- Explicit empty/unlimited snapshots must clear cached windows, whereas genuine zero usage remains a real quota.

### Task 1: Provider snapshots and parsing correctness

**Files:** Modify `extensions/lib/usage-providers.ts`; create `tests/usage-parsing.test.mjs`; adjust affected expectations in `tests/min-footer.test.mjs`.

**Interfaces:** Add `parseUsageWindows(provider: string, model: string, payload: unknown): Record<string, UsageWindow> | null`. A nonempty record is a full snapshot; `null` means explicitly absent applicable limits; malformed/unrecognized snapshots throw. Retain `parseUsage` as a shortest-window wrapper for existing callers. Stable keys: Codex `primary`/`secondary`, Claude `five_hour`/`seven_day`, MiniMax `interval`/`weekly`, Kimi duration-and-unit keys plus top-level `weekly`, OpenCode `rollingUsage`/`weeklyUsage`/`monthlyUsage`, Copilot snapshot names, Gemini bucket identities.

- [x] Add regression tests before implementation, importing TypeScript through existing Jiti dependency. Run `node --test tests/usage-parsing.test.mjs` and record expected failures.

```js
assert.equal(parseUsage('kimi-coding', '', {usage:{limit:'100',used:'40'}}).used, 40);
assert.equal(parseUsage('anthropic', '', {five_hour:{utilization:35,resets_at:'invalid'}}).resetAt, null);
assert.throws(() => parseUsage('openai-codex', '', {error:{message:'unexpected response'}}));
assert.equal(parseUsage('openai-codex', '', {rate_limit:null}), null);
```

- [x] Kimi accepts valid `used` or `remaining`, preferring explicit `used` when both exist. Require positive limits; add `TIME_UNIT_WEEK` and `TIME_UNIT_MONTH` conversion (7 and 30 days), preserving SECOND/MINUTE/HOUR/DAY. Test string numbers, used-only rolling and weekly, zero, invalid counts, and duration ordering.
- [x] Codex accepts numeric usage strings and computes absolute reset from `reset_after_seconds` only when valid `reset_at` is unavailable. Preserve zero relative delay; test absolute precedence and fake-clock conversion.

```js
const now = Date.now();
const result = parseUsage('openai-codex','',{rate_limit:{primary_window:{used_percent:35,limit_window_seconds:18000,reset_after_seconds:3600}}});
assert.ok(Math.abs(result.resetAt - (now + 3600000)) < 100);
```

- [x] Separate required usage validity from optional reset validity. Invalid optional reset becomes unknown; invalid explicit duration cannot masquerade as a known-short quota. Retain valid sibling windows when another is malformed. If no valid windows remain, return null only for a recognized explicit empty/unlimited/no-applicable-model result; otherwise throw. Pin this distinction for every supported provider.
- [x] Run focused tests, existing loader tests, and `npm run check`; write report including RED/GREEN commands and outcomes. Do not commit.

### Task 2: Polling recovery and passive-window merging

**Files:** Modify `extensions/lib/usage-limits.ts`; extend `tests/min-footer.test.mjs`.

**Interfaces:** Consume `parseUsageWindows` from Task 1. Keep public controller methods and rendering contract unchanged. Store windows by stable provider-local key; full endpoint snapshots replace them and explicit absence clears them. Partial headers/stream updates merge only valid supplied windows.

- [x] Write failing real-loader tests for a never-settling credential lookup, late resolution after timeout, and provider switching during auth. Run the file directly to capture failures.

```js
// With fake timers and getApiKeyAndHeaders returning a pending promise:
// startup -> one lookup; +5000ms -> request released; +240000ms -> a second lookup.
// Resolving the first lookup afterward must cause no fetch and no quota update.
```

- [x] Bound the await of credential resolution using an abort-aware promise that settles on timeout/cancellation and cleans up its abort listener. Underlying late resolutions/rejections must be handled and ignored. Existing fetch timeout still covers response-body consumption. Keep the same controller identity checks and four-minute attempt cadence.
- [x] Write failing partial-update tests for Claude and Codex: full 5h + weekly snapshot, then weekly-only passive data, still display 5h. Include a shorter-window usage-only update with omitted duration/reset metadata and retain compatible cached metadata.

```js
// Full snapshot 5h=35%, weekly=95%; weekly-only headers=96%.
// Footer remains the 35% five-cell bar, with the 5h reset.
// Repeated weekly-only signals must not push the 5h fallback refresh past four minutes.
```

- [x] Track freshness for the selected window rather than treating unrelated longer-window updates as fresh shortest-window usage. Schedule reset/fallback refresh without tight loops. Do not manufacture usage from status-only responses.
- [x] Add valid-cache -> malformed HTTP 200 -> dim retained bar -> valid refresh recovery test. Keep explicit no-limits clearing tests, zero usage tests, and provider-switch cancellation tests passing. Verify JSON-body timeout and late results after switching with focused fixtures.
- [x] Run `node tests/min-footer.test.mjs`, `npm test`, and `npm run check`; write report with RED/GREEN evidence. Do not commit.

### Task 3: Documentation and final integration review

**Files:** Modify `README.md` and `CHANGELOG.md` under Unreleased only.

- [x] Document merged partial signals, bounded auth recovery, malformed-vs-absent behavior, Kimi used-only support, and relative Codex resets. Preserve upstream MIT attribution and the current UI example.
- [x] The controller, following the user's main-thread takeover request, reads the combined implementation and checks the five fixes plus provider-switch and timer interactions. Investigate the remaining OpenCode endpoint uncertainty without live credentials or paid probes; do not claim its authenticated format is verified.
- [x] Delegate any necessary fixes, get scoped re-review, then controller runs `npm test`, `npm run check`, `git diff --check`, and `npm pack --dry-run --json --cache /tmp/pi-minimal-footer-npm-cache`.
- [x] Mark the plan complete and deliver a concise summary with verification and remaining limitations.
