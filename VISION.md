# Vision & developer guide

## Purpose

An opinionated footer that answers three questions at a glance: where am I, what is running, and how close am I to a limit? Keep one line, avoid redundant labels, and never exceed the terminal width.

The [README](README.md) is the user manual. This document records current design and contributor guidance—not a speculative roadmap.

## Layout contract

- Directory and Git branch form the left group, separated by ``.
- Each extension status is its own `` tab. Preserve the supplied text except for replacing line breaks and tabs with spaces; do not invent status labels, parentheses, or pipes.
- Model, context, and subscription usage form the rightmost group, separated by ` · `. Model identifies the running engine; context describes its usage; the usage bar stays anchored at the right edge.
- Powerline separators are dim. `powerlineSeparator: false` replaces them with a single space. Font availability cannot be detected reliably.
- Measure terminal columns with `visibleWidth`, not string length. Preserve ANSI styling and wide-character accounting when truncating.

### Space allocation

Reserve the usage bar and model/context before allocating location and statuses. Statuses and location may shorten or disappear; on sufficiently narrow terminals, model/context can also shorten or disappear. The model field is one protected unit: an optional `provider/` prefix, the bold model id, and an optional thinking level colored by Pi's `thinking*` theme tokens are truncated together, so the field never splits into separate segments.

Lay out other fields with a two-cell usage bar first, or fewer if `maxUsageBarCells` is smaller. Grow the bar only into leftover columns, up to `maxUsageBarCells` (default ten)—never truncate another field solely to enlarge it. At extreme widths, shrink to one cell, show only the reset label, or hide usage if neither can fit. Brackets keep an empty bar's edges visible and count toward its width, but not its cell cap. With `showUsage: false` no bar is reserved at all, and the usage owner is stopped before any credential lookup, request, or timer is created.

Two cells give 6.25% steps; ten give 1.25%. Fill rounds to the nearest eighth-cell step. Only the final partially filled cell uses an intermediate shade:

| Cell | Fill |
|---|---|
| `⠀` | Empty |
| `⡀` | One-eighth |
| `⣀` | Quarter |
| `⣄` | Three-eighths |
| `⣤` | Half |
| `⣦` | Five-eighths |
| `⣶` | Three-quarter |
| `⣷` | Seven-eighths |
| `⣿` | Full |

The bar and reset label have no intervening space. Reset formatting uses local clock time through 24 hours, remaining whole days/hours above 24 hours, and whole days above 10 days. Exactly 24 hours stays clock time; exactly 10 days is `↻10d0h`. Missing reset metadata leaves the bar visible without a label.

## Context display contract

- Default to tokens used / context window, with an explicit `k` suffix on both values. Never deduplicate units across the slash.
- Always use kilos, including for million-token windows (`1000k`, not `1M`). Below 10k, use two significant digits where one-token resolution permits, capped at three decimal places in kilos: `0.001k`, `0.012k`, `0.11k`, `0.78k`, `0.99k`, `1.0k`, `9.0k`. At and above 10k, round to whole kilos: `10k`, `124k`, `1000k`. Zero is `0k`; rounding can promote `9.999k` to `10k`.
- `minFooter.contextAsPercentage` defaults to `false`. Opting in replaces only the numerator with percentage used to one decimal place, e.g. `24.7%/500k`. Keep context distinct from the subscription usage bar.
- Reload settings at installation boundaries (enable and session start) before deriving footer state, so the first render uses the effective configuration. Ordinary refreshes use the cached configuration and must not reload settings.
- Unknown token usage is `?/500k` in either mode; absent context usage is `?`. Never present unknown usage as zero.

## Git contract

- Pi supplies the branch name. Query `git rev-list --left-right --count HEAD...@{upstream}` for `↑N` local-only and `↓N` upstream-only commits. Use local refs; no remote fetch by default.
- Query outside rendering with a one-second timeout so Git cannot block the TUI. Missing upstreams and command failures omit counts.
- Refresh on branch-change signals and footer state updates, plus every 91 seconds while the footer is active so external commits are noticed even when Pi is idle. `minFooter.gitRefreshSeconds` accepts integer seconds from 1 through 2,147,483 (Node's maximum timer delay); invalid values fall back to 91. Local-only queries permit a shorter interval than subscription usage polling without network traffic. Stop the timer on footer disposal. Ignore older query results to prevent stale counts from restarting highlights.
- Use the theme's normal text foreground while unsynced, otherwise dim. A count change pulses the whole Git section (icon, branch, and counts) bold for one second to call attention without persistent emphasis or turn-count bookkeeping; this is independent of synced/unsynced foreground color. Further changes restart the timer. Expiry requests a redraw even while idle. User submissions and tool turns do not affect the pulse. Dispose cancels the timer.
- Initial loading and working-directory changes establish an unhighlighted baseline. Zero counts hide the arrows entirely.
- `minFooter.gitFetch` (default `false`) opts into asynchronous `git fetch --quiet` on footer startup and every five minutes with ±⅛ jitter (262.5–337.5 seconds), sampled after each completed attempt. Jitter spreads network load across sessions; local divergence polling remains independent. Disable interactive credential prompts; failures are silent and retry at the next interval. `gitFetchTimeoutSeconds` accepts integer seconds from 1 through 2,147,483 (Node's maximum timer delay), default/fallback 17. Successful fetches refresh divergence. Footer disposal clears the timer and aborts an in-flight fetch; only interactive sessions with an active footer fetch.

## Subscription usage contract

Display only the selected provider's shortest applicable window. Subscription usage and model context usage are separate measurements.

| Provider | Selection / caveat |
|---|---|
| OpenAI Codex (`openai-codex`) | Shortest primary/secondary window; supports absolute reset timestamps and relative reset delays |
| Claude (`anthropic`, OAuth) | Five-hour window, or weekly fallback; ordinary API keys do not expose subscription usage |
| GitHub Copilot (`github-copilot`) | Most-used limited quota bucket; unlimited buckets hidden |
| Gemini CLI (`google-gemini-cli`) | Selected model, with Pro/Flash family fallback; needs a configured provider/model |
| MiniMax (`minimax`, `minimax-cn`) | Prefer general bucket, then active bucket, then first bucket; shortest interval/weekly window |
| Kimi Coding (`kimi-coding`) | Shortest available window; accepts used or remaining counts and week/month durations |
| OpenCode Go (`opencode-go`) | Shortest rolling/weekly/monthly window |

Reuse Pi's selected-provider credentials. Copilot uses the saved OAuth GitHub login token when applicable; otherwise it uses the credentials resolved by Pi, which can include `COPILOT_GITHUB_TOKEN`. Ambient environment tokens do not override Pi's resolved credentials. Pi 1.0.3 does not include Gemini CLI in its built-in model catalog. Do not poll custom proxy endpoints or make model requests to obtain usage.

### Refresh and failure behavior

- Consume passive Codex response headers/stream events and Claude quota headers when available.
- Otherwise fetch on startup/provider switch, then roughly every four minutes without a fresh response update. Sample independent uniform ±⅛ jitter (3.5–4.5 minutes) for each attempt or fresh displayed-window update to spread fallback requests across sessions. Keep that deadline across unrelated window updates; a reported reset time still triggers an earlier refresh.
- Merge partial windows. A weekly-only signal must not replace a cached shorter window or postpone its refresh.
- Bound authentication, fetch, and response-body parsing by a shared nine-second timeout. Release stalled work so polling can recover.
- Provider switches clear usage immediately, cancel pending work, and invalidate late results. Gemini model switches also refresh model-specific usage.
- Missing credentials and explicit empty/unlimited responses clear usage. Temporary authentication, network, or parsing failures retain only the current provider's cached usage, dimmed; without cache, hide it.
- Invalid optional reset metadata must not discard otherwise valid usage. Zero usage is an empty bar, not an absent usage bar.
- Stop requests and timers on disable, disposal, and session shutdown.

### Verification limits

Parsing and lifecycle behavior have automated coverage. Authenticated provider endpoints have **not** been tested live. OpenCode Go's bearer-token response format and Copilot's public endpoint/enterprise compatibility remain unverified.

The comparison with [mtrojnar/pi-usage](https://github.com/mtrojnar/pi-usage) informed timeout, validation, and partial-update handling; its OpenCode implementation uses an authenticated dashboard rather than this adapter's bearer-token endpoint.

## Local development

Requires Node.js >=22.19.0. Local dependencies pin Pi 1.0.3; compatibility CI is configured to test Pi 1.0.3, 1.1.0, and 1.3.0 on Node.js 22.19.0. Provider requests are mocked. These are tested versions, not a guarantee for every intervening or future release.

```bash
npm ci
npm run check
npm test

# Isolated interactive preview; Pi loads TypeScript directly, no build needed:
pi --no-extensions -e ./extensions/index.ts
```

Use `/reload` after edits. For a persistent development install:

```bash
ln -s "$PWD/extensions" ~/.pi/agent/extensions/minimal-footer
```

For a manual install, copy `extensions/*` into `~/.pi/agent/extensions/`.

### Plugin integration

Use Pi's standard status API to contribute text without replacing the footer:

```typescript
ctx.ui.setStatus("my-extension", "Working");
ctx.ui.setStatus("my-extension", "Ready"); // update the same entry
ctx.ui.setStatus("my-extension", undefined); // remove it
```

Use a unique key. Pi requests a redraw when statuses change; no footer-specific event is needed. `showSkills` controls status visibility. Narrow terminals may truncate or omit entries to preserve model/context and usage information.

Footer ownership is exclusive: another extension calling `ctx.ui.setFooter()` replaces this footer. Usage requests, new Git queries, and footer-owned timers stop on disposal; an in-flight Git query may complete, but lifecycle state refreshes alone never start one.

#### Session-only footer control

Extensions can temporarily override footer visibility without changing the user's saved setting:

```typescript
pi.events.emit("pi-minimal-footer:set-enabled", { enabled: false });
pi.events.emit("pi-minimal-footer:set-enabled", { enabled: true });
```

Emit after this extension's `session_start` handler has run; events before startup or after shutdown are ignored. The payload must contain a boolean `enabled`; invalid payloads are ignored. Changes are silent and do not write settings.

The latest explicit action wins: `/minfooter on/off` changes the current footer and saves the preference, while this event changes only the current session. Normal refreshes never undo the choice. A new session or extension reload starts from the saved preference.

Disabling restores Pi's default footer only if we still own the active footer; otherwise it leaves the active footer untouched. Enabling explicitly installs our footer and may replace another extension's footer. Repeated enable events while we own it do nothing; `/minfooter on` reloads settings and reinstalls the footer. Neither action restores a previous extension's footer. A coordinating extension must choose the active footer—there is no priority stack or automatic reactivation.

#### Session-only usage control

Control subscription usage independently of footer visibility:

```typescript
pi.events.emit("pi-minimal-footer:set-usage-enabled", { enabled: false }); // suppress usage
pi.events.emit("pi-minimal-footer:set-usage-enabled", { enabled: true });  // enable usage
pi.events.emit("pi-minimal-footer:set-usage-enabled", { enabled: null });  // restore saved showUsage
```

- A boolean overrides `minFooter.showUsage`; `null` clears the override. No settings writes or notifications.
- Emit after this extension's `session_start` handler. Events outside an active session, missing `enabled`, and values other than boolean or `null` are ignored. Repeated override values do nothing.
- Disabling clears cached usage, cancels pending requests, and stops timers. Late results and passive provider updates cannot revive usage.
- Enabling selects usage only while the footer is enabled, owns a live renderer, and runs in TUI mode. It never installs or replaces a footer.
- Changes request a redraw without reinstalling the renderer or refreshing Git.
- The override survives footer toggles and reinstallation, but resets on session start/shutdown and extension reload. Clearing it uses the cached setting; settings reload at the normal installation boundaries.
- No automatic host detection. A coordinating extension can suppress duplicate quota reporting, for example when a terminal plugin already displays usage.

### Code map

- `extensions/index.ts`: Pi events/commands, footer ownership, model/context formatting, theme application, and module wiring.
- `extensions/lib/footer-settings.ts`: defaults, validation, and settings persistence; preserves unrelated preferences.
- `extensions/lib/footer-layout.ts`: width allocation and truncation of supplied segments, independent of Pi lifecycle and theme selection.
- `extensions/lib/git-status.ts`: Git divergence state, stale-result protection, highlight pulses, local polling, and optional fetch/cancellation. The active renderer starts/stops this lifecycle; superseded renderer disposal cannot stop its replacement.
- `extensions/lib/usage-limits.ts`: usage refresh, cache, cancellation, and bar/reset rendering.
- `extensions/lib/usage-providers.ts`: authentication, endpoint selection, and named private provider parsers. `parseUsageWindows` gates supported endpoints, dispatches parsing with an explicit snapshot, and centrally distinguishes valid windows, absence, and malformed responses.
- `tests/min-footer.test.mjs`: settings, session lifecycle, and context-format integration coverage.
- `tests/layout.test.mjs`: layout, ANSI/Unicode, and usage bar/reset formatting.
- `tests/git.test.mjs`: fetch jitter, live ownership, stale queries across refresh/restart/directory changes, and Git highlighting with a temporary repository.
- `tests/usage-lifecycle.test.mjs`: usage authentication, polling, cancellation, passive updates, and provider integration.
- `tests/helpers/footer-fixture.mjs`: shared real-loader/context helpers and per-process isolated agent/home setup, default settings resets, and teardown.
- `tests/usage-parsing.test.mjs`: provider parsing.
- `tests/persistence-order.test.mjs`: real `AgentSession` message persistence and post-persistence footer usage.

Settings live under `minFooter` in Pi's configured agent directory. Read them at session start or explicit toggle; ordinary refreshes use cached settings. Preserve unrelated settings on writes. Only install the footer in interactive terminal mode.

### Checking changes

Run `npm run check` and `npm test` for behavior changes. Each test file can also run independently, e.g. `node --test tests/git.test.mjs`. Keep the default per-file process isolation: the shared footer fixture sets isolated agent/home environment paths before importing Pi and resets settings and `Math.random` for each test. Provider requests are mocked; numeric context formatting remains real-loader integration coverage. Cover relevant cases:

- Layout: narrow widths, ANSI/wide Unicode, field priority, and separator modes.
- Git: divergence, synced styling, highlight expiry/restart, and user submissions versus tool turns.
- Subscription usage: provider switches, timeouts, stale cache, partial updates, and malformed/missing metadata.

Preview font-dependent appearance in a real terminal; width checks cannot prove glyph availability.

Keep release notes in [CHANGELOG.md](CHANGELOG.md), and keep the README focused on installation and daily use. Preserve [upstream MIT attribution](extensions/lib/LICENSE) when changing adapted provider code.
