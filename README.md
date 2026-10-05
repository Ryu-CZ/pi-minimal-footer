# pi-minimal-footer

<p>
  <a href="https://www.npmjs.com/package/pi-minimal-footer">
    <img src="https://img.shields.io/npm/v/pi-minimal-footer" alt="npm version">
  </a>
  <a href="https://www.npmjs.com/package/pi-minimal-footer">
    <img src="https://img.shields.io/npm/dt/pi-minimal-footer" alt="npm downloads">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/npm/l/pi-minimal-footer" alt="license">
  </a>
  <a href="https://pi.dev/packages/pi-minimal-footer">
    <img src="https://img.shields.io/badge/pi-package-1a1a2e" alt="pi package">
  </a>
</p>

An opinionated, clean, compact footer for [Pi](https://github.com/earendil-works/pi).

```
~/git/pi-minimal-footer   main       (icarus | goal running)  gpt-5.6-sol  12/128k    ⣿⣶⠀⠀⠀ ↻16:40
```

![pi-minimal-footer screenshot](media/github-preview.png)

## Install

Available on the [Pi package gallery](https://pi.dev/packages/pi-minimal-footer).

```bash
# From npm (recommended)
pi install npm:pi-minimal-footer

# From git
pi install git:github.com/Ryu-CZ/pi-minimal-footer

# Manual — copy into your extensions directory
cp -r extensions/* ~/.pi/agent/extensions/

# Development — symlink for live edits
ln -s "$PWD/extensions" ~/.pi/agent/extensions/minimal-footer
```

## Development

Requires Node.js >=22.19.0. Run `npm ci`, `npm run check`, and `npm test`. Pi loads TypeScript directly; no build is needed. For an isolated local preview, run `pi --no-extensions -e ./extensions/index.ts`. After source edits, use `/reload` in Pi. Tests use Pi 1.0.3 and make no provider requests.

## Features

- **Working directory** — home abbreviated as `~`; paths outside home remain absolute
- **Extension statuses** — text reported by extensions through Pi's status API (`showSkills` retains its existing setting name; it does not discover installed skills)
- **Git branch** — current branch name
- **Model** — active model ID
- **Context usage** — tokens used / context window (e.g., `12/128k`). After compaction, Pi reports usage as unknown (`?`) until a subsequent model response.
- **Provider quota** — the right end shows the selected provider's shortest available quota as a Braille bar and local reset time in 24-hour `HH:mm` format, when reported.

The directory and git branch stay together on the left. Extension statuses, model, context usage, and quota stay on the right, with extra spacing before the quota. Statuses and location are muted; the model is bold.

On narrow terminals, the directory and statuses shorten or disappear, then the branch disappears. The quota bar shrinks before model/context is shortened, preserving the reset time. The footer always uses one line.

The footer appears only in Pi's interactive terminal UI, not in print, JSON, or RPC modes.

### Provider usage limits

The footer displays only the selected provider's shortest available quota window, typically five hours. If only a weekly or monthly quota is available, it displays that quota. This measures account quota used, separately from the model's context usage (`12/128k`).

| Provider | Quota selection |
|---|---|
| OpenAI Codex (`openai-codex`) | Shortest primary/secondary window |
| Claude (`anthropic`, OAuth) | Five-hour window, or weekly if that is all that is reported |
| GitHub Copilot (`github-copilot`) | Limited premium/chat quota; unlimited buckets are hidden |
| Gemini CLI (`google-gemini-cli`) | Selected model's quota, with Pro/Flash family fallback |
| MiniMax (`minimax`, `minimax-cn`) | General text bucket's shortest interval/weekly window |
| Kimi Coding (`kimi-coding`) | Shortest reported window, or weekly fallback |
| OpenCode Go (`opencode-go`) | Shortest rolling/weekly/monthly window |

The adapters reuse the selected provider's authentication from Pi. Claude subscription quota requires OAuth; ordinary Claude API keys do not expose it. Copilot's quota endpoint uses the GitHub login token from Pi's configured agent directory or `COPILOT_GITHUB_TOKEN`. Gemini CLI needs a configured provider/model; Pi 1.0.3 does not include that provider in its built-in catalog.

The usage segment contains only a five-cell Braille bar and its reset time:

```text
⣿⣶⠀⠀⠀ ↻16:40
```

This example shows 35% used. `↻16:40` means the quota resets at 16:40 in your local timezone: an absolute 24-hour time, not a countdown. No provider name, window label, percentage, or date is displayed.

If the provider does not report a reset time, only the bar is shown:

```text
⣿⣶⠀⠀⠀
```

Each cell uses comic-style dot shading, starting from the bottom:

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

Each step adds one dot from the bottom upward. Five cells provide 2.5% steps, rounded to the nearest step; only the last partially filled cell uses an intermediate state. Filled cells are green below 85%, amber from 85%, and red from 92%. On narrow terminals the bar shrinks to preserve the reset time, so its steps become coarser.

Usage refreshes from Codex response headers/stream events and Claude quota response headers when available. Otherwise, the footer checks the selected provider's usage endpoint on startup or provider switch, then every four minutes without a fresh response update. It also checks when a reported reset time arrives. These checks make no model requests.

Partial response updates are merged with cached windows. A weekly-only update keeps the cached five-hour quota visible and does not postpone its refresh. Authentication, fetching, and response parsing share a five-second timeout; a stalled lookup or body read releases the request and allows the next scheduled attempt. Late results cannot restore a previous provider's quota.

Codex endpoint responses can supply either an absolute reset timestamp or a relative reset delay. Kimi quotas accept either used or remaining counts, including week/month durations. Invalid optional reset metadata leaves the bar visible without a time.

Switching providers immediately clears the previous quota, cancels its requests and timers, and ignores late results. Switching back fetches fresh data. Gemini model switches also refresh the model-specific quota. A previous provider's bar never remains visible while the new provider loads.

Local models, unsupported providers, and sessions without a selected model show no usage segment and make no usage requests. Missing credentials or a successful usage response without an applicable quota hide the segment, including any previously cached bar. Zero usage still displays an empty bar, with its reset time when available.

If a refresh fails temporarily or returns malformed quota data, the current provider's last known bar is dimmed until fresh data arrives; without cached data, the segment stays hidden. Explicit empty or unlimited quota responses clear the cached bar. Requests and timers also stop when the footer is disabled, disposed, or the session shuts down. Custom proxy endpoints are not polled. Live quota availability depends on each provider's endpoint; unavailable endpoints stay silent.

The adapters have automated parsing and lifecycle coverage, but authenticated provider endpoints have not been tested live. In particular, OpenCode Go's bearer-token response format and Copilot's public quota endpoint and enterprise compatibility remain unverified. The comparison with [mtrojnar/pi-usage](https://github.com/mtrojnar/pi-usage) informed the timeout, validation, and partial-update handling; its OpenCode implementation uses an authenticated dashboard instead.

### Credits

Honorable mention and thanks to **Can Celik (@ogulcancelik)**: the provider usage-fetching and quota-parsing logic was **copied and adapted from [@ogulcancelik/pi-minimal-footer](https://pi.dev/packages/@ogulcancelik/pi-minimal-footer)**. This footer keeps its minimal layout, five-cell bottom-up Braille display, and four-minute refresh behavior. The upstream MIT copyright and license are retained in [extensions/lib/LICENSE](extensions/lib/LICENSE).

## Commands

| Command | Description |
|---|---|
| `/minfooter` | Toggle the extension on/off |
| `/minfooter on` | Enable |
| `/minfooter off` | Disable |

> The `/minfooter` command only toggles the `enabled` flag. To show or hide individual segments, edit the agent settings file directly.

## Configuration

Settings live in Pi's configured agent directory, in `settings.json` under the `minFooter` key (normally `~/.pi/agent/settings.json`). The footer reads settings on session start and when `/minfooter` is run; external edits do not take effect until one of those actions (there is no file watcher). Unrelated settings are preserved when toggling.

```json
{
  "minFooter": {
    "enabled": true,
    "showGitBranch": true,
    "showSkills": true,
    "showPath": true,
    "showModel": true,
    "showContext": true
  }
}
```
