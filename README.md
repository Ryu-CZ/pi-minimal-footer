# pi-minimal-footer

<p>
  <a href="https://www.npmjs.com/package/pi-minimal-footer"><img src="https://img.shields.io/npm/v/pi-minimal-footer" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-minimal-footer"><img src="https://img.shields.io/npm/dt/pi-minimal-footer" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/pi-minimal-footer" alt="license"></a>
  <a href="https://pi.dev/packages/pi-minimal-footer"><img src="https://img.shields.io/badge/pi-package-1a1a2e" alt="pi package"></a>
</p>

An opinionated, compact, one-line status bar for [Pi](https://github.com/earendil-works/pi).

![Footer preview: ~/git/project   main ↑2 · 🧠 Karpathy · 🪽 Icarus · gpt-6-sol · 42k/200k · subscription usage with reset time](media/preview.png)

**Left**

- Working directory: `~/git/project`
- Git branch: ` main ↑2 ↓1` (`↑` to push, `↓` to pull)

**Right**

- Extension statuses: ` 🧠 Karpathy  🪽 Icarus`
- Model: `model`
- Context usage: `42k/200k` (default), or `21.0%/200k` with `contextAsPercentage: true`
- Subscription usage bar with reset time: `[⣿⣿⣿⣤⠀⠀⠀⠀⠀⠀]↻1d8h`

## Install

Requires Node.js >=22.19.0. Interactive terminal UI only.

Choose one npm name (they contain the same extension; do not install both):

```bash
pi install npm:pi-minimal-footer
```

The scoped package is an official mirror, not a separate extension.

## Commands

| Command | Action |
|---|---|
| `/minfooter` | Toggle footer |
| `/minfooter on` | Enable |
| `/minfooter off` | Disable |

## Settings

Edit `minFooter` in Pi's agent `settings.json` (normally `~/.pi/agent/settings.json`). All defaults are shown below. Apply edits with `/reload` or `/minfooter on`.

```json
{
  "minFooter": {
    "enabled": true,
    "showGitBranch": true,
    "showSkills": true,
    "showPath": true,
    "showModel": true,
    "showContext": true,
    "showProvider": false,
    "showThinking": false,
    "showUsage": true,
    "contextAsPercentage": false,
    "powerlineSeparator": true,
    "gitRefreshSeconds": 91,
    "gitFetch": false,
    "gitFetchTimeoutSeconds": 17,
    "maxUsageBarCells": 10
  }
}
```

- `showProvider` prefixes the model with its provider id, e.g. `opencode-go/deepseek-v4.1-flash`; default `false`.
- `showThinking` appends the thinking level for reasoning models, e.g. `deepseek-v4.1-flash high` or `thinking off`, in Pi's matching `thinking*` theme color; default `false`.
- `showSkills` shows **extension status text**, not installed skills. The footer does not add the example statuses itself.
- `showUsage` enables this footer's own provider usage queries and the subscription usage bar; set it to `false` when another extension already publishes quota; default `true`.
- Set `powerlineSeparator` to `false` for plain spaces instead of `` / `` if your font lacks those glyphs. The git icon `` and sync arrows also need compatible glyphs; hide Git data with `showGitBranch: false` if needed.
- `gitRefreshSeconds`: local refresh interval; `1`–`2147483` seconds; default `91`.
- `gitFetch`: background fetch on startup, then roughly 5 minutes after each attempt completes; failures are silent; default `false`.
- `gitFetchTimeoutSeconds`: fetch timeout; `1`–`2147483` seconds; default `17`. Invalid timer settings use their defaults.
- `maxUsageBarCells` caps the Braille bar length (excluding brackets and reset time). Use a positive integer, e.g. `4` for a compact bar; invalid values fall back to `10`.

## Reading the footer

### Git

Counts require a configured upstream. Unsynced branches use normal text color; synced branches are dim. Count changes pulse the whole Git section bold for one second; further changes restart the pulse.

### Context

`42k/200k` means tokens used / context window. Set `"contextAsPercentage": true` under `minFooter` to show `21.0%/200k` instead. Unknown token usage shows `?/200k` when the window is known, or `?` when context information is unavailable.

The whole context label keeps its normal dim color below 85% of Pi’s compaction trigger (`contextWindow - reserveTokens`), turns yellowish (`warning`) at 85%, and red (`error`) at 92%. It uses Pi’s effective compaction settings, including exact `provider/modelId` overrides, with a default reserve of 16,384 tokens. Colors apply in both display modes, even when auto-compaction is disabled. Unknown usage or a non-positive trigger keeps the normal color.

### Subscription usage

`[⣿⣿⣿⣤⠀⠀⠀⠀⠀⠀]↻1d8h` shows **subscription allowance used**, not context usage.

- **Bar:** expands into spare space, using 2–10 cells by default, capped by `maxUsageBarCells`. Smaller caps and very narrow terminals may show fewer cells or only the reset label.
- **Colors:** green below 85%, amber from 85%, red from 92%.
- **Cached data:** dim after a refresh failure or when its reset time has passed.
- Reset: local `↻HH:mm` through 24 hours; whole days/hours above 24 hours (`↻1d8h`); whole days above 10 days (`↻12d`). Remaining durations round down. No reset reported means bar only.
- Shows the shortest available usage window for the selected provider. Missing credentials, unsupported/local models, or absent limits hide the usage bar. Custom proxy endpoints are not polled.
- Virtual/routed models show model and context usage, but no subscription bar.

#### Adapters

Adapters use Pi's existing credentials; ordinary Claude API keys do not expose subscription usage.

*Authenticated endpoints remain unverified live; see [verification limits](VISION.md).*

Implemented adapters:
 - **OpenAI Codex**
 - **Claude OAuth**
 - **GitHub Copilot**
 - **Gemini CLI**
 - **MiniMax**
 - **Kimi Coding**
 - **OpenCode Go**

### Extension statuses

Provided by other extensions; hidden with `showSkills: false`. Narrow terminals may shorten or omit them.

Only one footer extension can be active. For plugin integration, see [VISION.md](VISION.md#plugin-integration).

## Programmatic control

Other Pi extensions can control this footer without changing saved preferences:

- **Footer** (`pi-minimal-footer:set-enabled`): enable or disable for the current session.
- **Subscription usage** (`pi-minimal-footer:set-usage-enabled`): show or hide the bar and its background queries independently—useful when your terminal already shows quota.
- New sessions and `/reload` restore saved preferences.

Event API and integration rules: [developer guide](VISION.md#session-only-footer-control).

## Development & design

Install from source:

```bash
pi install git:github.com/Ryu-CZ/pi-minimal-footer
```

Developer guide: [VISION.md](VISION.md). Release history: [CHANGELOG.md](CHANGELOG.md).

## Credits

Provider usage-fetching and parsing logic **copied and adapted from [Can Celik (@ogulcancelik)'s pi-minimal-footer](https://pi.dev/packages/@ogulcancelik/pi-minimal-footer)**. Upstream MIT attribution is retained in [extensions/lib/LICENSE](extensions/lib/LICENSE).
