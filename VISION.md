# Vision & developer guide

## Purpose

An opinionated footer that answers three questions at a glance: where am I, what is running, and how close am I to a limit? Keep one line, avoid redundant labels, and never exceed the terminal width.

The [README](README.md) is the user manual. This document records current design and contributor guidance—not a speculative roadmap.

## Layout contract

- Directory and git branch form the left group, separated by ``. Pi supplies the branch name; the extension asynchronously runs `git rev-list --left-right --count HEAD...@{upstream}` to append local/upstream divergence as `↑N`/`↓N` (push/pull). The counts are omitted when no upstream is configured, and Git work stays outside synchronous rendering so a slow repository cannot block the TUI.
- Each extension status is its own `` tab. Preserve the supplied text; do not invent status labels, parentheses, or pipes.
- Model, context, and subscription usage form the rightmost group, separated by ` · `. Model identifies the running engine; context describes its usage; the usage bar stays anchored at the right edge.
- Powerline separators are dim. `powerlineSeparator: false` replaces them with a single space. Font availability cannot be detected reliably.
- Measure terminal columns with `visibleWidth`, not string length. Preserve ANSI styling and wide-character accounting when truncating.
- Git divergence refreshes on Pi's branch-change signal and normal footer state refreshes; it is best-effort and never allowed to prevent the footer from loading. Changed counts are bold until two subsequent user submissions, not tool turns; changes restart that window. Initial loading and working-directory changes establish an unhighlighted baseline. Overlapping queries ignore older results.

### Space allocation

Reserve the usage bar and model/context before allocating location and statuses. Statuses and location may shorten or disappear; on sufficiently narrow terminals, model/context can also shorten or disappear.

Lay out other fields with a two-cell usage bar first. Grow the bar only into leftover columns, up to ten cells—never truncate another field solely to enlarge it. At extreme widths, shrink to one cell, show only the reset label, or hide usage if neither can fit. Brackets keep an empty bar's edges visible and count toward its width, but not its cell cap.

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

Reuse Pi's selected-provider credentials. Copilot uses the GitHub login token from Pi's configured agent directory or `COPILOT_GITHUB_TOKEN`. Pi 1.0.3 does not include Gemini CLI in its built-in model catalog. Do not poll custom proxy endpoints or make model requests to obtain usage.

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

Requires Node.js >=22.19.0. Tests currently use Pi 1.0.3 and mock provider requests.

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

### Code map

- `extensions/index.ts`: settings, state refresh, layout, footer lifecycle, and `/minfooter`.
- `extensions/lib/usage-limits.ts`: usage refresh, cache, cancellation, and bar/reset rendering.
- `extensions/lib/usage-providers.ts`: authentication, endpoint selection, and response normalization.
- `tests/`: loader-based lifecycle/layout regression tests and usage parsing tests.

Settings live under `minFooter` in Pi's configured agent directory. Read them at session start or explicit toggle; ordinary refreshes use cached settings. Preserve unrelated settings on writes. Only install the footer in interactive terminal mode.

### Checking changes

For behavior changes, run `npm run check` and `npm test`. Layout tests should cover narrow widths, ANSI text, wide Unicode, field priority, and both separator modes. Subscription usage changes should cover provider switches, timeouts, stale cache, partial updates, and malformed/missing metadata as applicable. Preview in a real terminal for font-dependent appearance; automated width checks cannot prove glyph availability.

Keep release notes in [CHANGELOG.md](CHANGELOG.md), and keep the README focused on installation and daily use. Preserve [upstream MIT attribution](extensions/lib/LICENSE) when changing adapted provider code.
