# pi-minimal-footer

<p>
  <a href="https://www.npmjs.com/package/pi-minimal-footer"><img src="https://img.shields.io/npm/v/pi-minimal-footer" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-minimal-footer"><img src="https://img.shields.io/npm/dt/pi-minimal-footer" alt="npm downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/pi-minimal-footer" alt="license"></a>
  <a href="https://pi.dev/packages/pi-minimal-footer"><img src="https://img.shields.io/badge/pi-package-1a1a2e" alt="pi package"></a>
</p>

Pi minimal footer is an opinionated, compact, one-line status bar for [Pi](https://github.com/earendil-works/pi).

![Footer preview: ~/git/project   main        🧠 Karpathy  🪽 Icarus  model · 42/200k · [⣿⣿⣿⣤⠀⠀⠀⠀⠀⠀]↻1d8h](media/github-preview.png)

**Left**

- Working directory: `~/git/project`
- Git branch: ` main ↑2 ↓1` (`↑` to push, `↓` to pull)

**Right**

- Extension statuses: ` 🧠 Karpathy  🪽 Icarus`
- Model: `model`
- Context usage: `42/200k`
- Subscription usage bar with reset time: `[⣿⣿⣿⣤⠀⠀⠀⠀⠀⠀]↻1d8h`

## Install

Requires Node.js >=22.19.0. Interactive terminal UI only.

Choose one npm name (they contain the same extension; do not install both):

```bash
pi install npm:pi-minimal-footer
# or
pi install npm:@ryu-cz/pi-minimal-footer
```

`pi-minimal-footer` remains the original, unscoped release path. The scoped
`@ryu-cz/pi-minimal-footer` package is an official mirror intended to improve
package indexing; it is not a separate extension. The scoped name is an
indexing workaround, not a guaranteed fix for pi.dev catalog search.

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
    "powerlineSeparator": true,
    "gitRefreshSeconds": 91,
    "gitFetch": false,
    "gitFetchTimeoutSeconds": 17,
    "maxUsageBarCells": 10
  }
}
```

- `showSkills` shows **extension status text**, not installed skills. The footer does not add the example statuses itself.
- Set `powerlineSeparator` to `false` for plain spaces instead of `` / `` if your font lacks those glyphs. The git icon `` and sync arrows also need compatible glyphs; hide Git data with `showGitBranch: false` if needed.
- `gitRefreshSeconds`: local Git refresh interval; positive integer seconds; default/fallback `91`.
- `gitFetch`: opt-in background fetch on footer startup; then every 5 minutes ±⅛ (262.5–337.5 seconds); silent failures; default `false`.
- `gitFetchTimeoutSeconds`: fetch timeout; positive integer seconds; default/fallback `17`.
- `maxUsageBarCells` caps the Braille bar length (excluding brackets and reset time). Use a positive integer, e.g. `4` for a compact bar; invalid values fall back to `10`.

## Reading the footer

### Git

Counts require a configured upstream. Unsynced branches use the theme's normal foreground; synced branches are dim. Changed counts stay bold until two subsequent user messages; further changes restart the highlight.

### Context

`42/200k` means tokens used / context window. `?` means Pi has not reported usage yet, including immediately after compaction.

### Subscription usage

`[⣿⣿⣿⣤⠀⠀⠀⠀⠀⠀]↻1d8h` shows **subscription allowance used**, not context usage.

- **Bar:** expands into spare space, using 2–10 cells by default, capped by `maxUsageBarCells`. Smaller caps and very narrow terminals may show fewer cells or only the reset label.
- **Colors:** green below 85%, amber from 85%, red from 92%.
- **Cached data:** dim after a refresh failure.
- Reset: local `↻HH:mm` through 24 hours; whole days/hours above 24 hours (`↻1d8h`); whole days above 10 days (`↻12d`). Remaining durations round down. No reset reported means bar only.
- Shows the shortest available usage window for the selected provider. Missing credentials, unsupported/local models, or absent limits hide the usage bar. Custom proxy endpoints are not polled.
- Virtual/routed selections show the selected model name and Pi's context usage, but no subscription bar. The physical provider may change between requests; this footer does not infer quota ownership from routed responses.

Implemented adapters: **OpenAI Codex, Claude OAuth, GitHub Copilot, Gemini CLI, MiniMax, Kimi Coding, and OpenCode Go**. Uses Pi's existing credentials; ordinary Claude API keys do not expose subscription usage. Authenticated endpoints remain unverified live; see [verification limits](VISION.md).

### Extension statuses

Other extensions contribute text through Pi's standard status API:

```typescript
ctx.ui.setStatus("my-extension", "Working");
ctx.ui.setStatus("my-extension", "Ready"); // update the same entry
ctx.ui.setStatus("my-extension", undefined); // remove it
```

Use a unique key for your extension. Pi requests a redraw when statuses change; no footer-specific hooks are needed. `showSkills: false` hides these entries, and narrow terminals may truncate or omit them to preserve model/context and usage information.

Only one extension can own Pi's footer. Another extension calling `ctx.ui.setFooter()` replaces this footer; use `setStatus()` to contribute text without replacing it.

## Development & design

Install from source:

```bash
pi install git:github.com/Ryu-CZ/pi-minimal-footer
```

Compatibility CI runs tests and TypeScript checks against pinned Pi versions **1.0.3 and 1.1.0**, on Node.js **22.19.0**. These are tested versions, not a guarantee for every intervening or future release.

See [VISION.md](VISION.md) for design constraints, local development, provider details, and verification limits. Release history: [CHANGELOG.md](CHANGELOG.md).

## Credits

Provider usage-fetching and parsing logic **copied and adapted from [Can Celik (@ogulcancelik)'s pi-minimal-footer](https://pi.dev/packages/@ogulcancelik/pi-minimal-footer)**. Upstream MIT attribution is retained in [extensions/lib/LICENSE](extensions/lib/LICENSE).
