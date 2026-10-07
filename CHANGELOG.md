# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-10-07

### Added

- `minFooter.maxUsageBarCells` (default `10`) to cap the subscription usage bar length; use a positive integer such as `4` for a compact bar, excluding brackets and reset time

### Changed

- Reduce the compact subscription usage bar baseline from five to two cells before expanding into spare space up to the configured cap
- Add one space at each footer edge, reserving those columns when fitting narrow terminals
- Refresh README and package-gallery PNG previews with the current footer, edge padding, and live OpenAI Codex subscription usage

## [0.3.3] - 2026-10-07

### Changed

- Add square brackets around the subscription usage bar so its beginning and end remain visible when empty
- Randomize subscription usage fallback refreshes by ±⅛ of the four-minute interval (3.5–4.5 minutes), preserving reset-time checks and deadlines across unrelated window updates
- Raise the subscription usage request timeout from five to nine seconds before aborting stalled authentication, fetch, or response-body waits

## [0.3.2] - 2026-10-06

### Changed

- Rename provider quota terminology to subscription usage in documentation, code, and tests; behavior is unchanged

## [0.3.1] - 2026-10-06

### Fixed

- Keep quota requests and timers stopped after another extension removes or replaces the footer, even when the model changes; explicit reinstallation restores polling
- Use all spare columns for responsive quota bars when the left group is absent
- Fall back to default settings when the JSON root is null, a scalar, or an array

### Changed

- Clarify renderer ownership and layout budgeting with rationale comments; isolate reset-label formatting and name shared bar-size limits

## [0.3.0] - 2026-10-06

### Added

- `minFooter.powerlineSeparator` (default `true`); set to `false` for a single-space fallback when the terminal font lacks Powerline glyphs

### Changed

- Keep README focused on installation and daily use; move design constraints, developer guidance, and provider details into `VISION.md`
- Separate directory and git branch with ``; render each extension status as its own `` tab, without footer-added parentheses or pipes
- Group model, context, and quota with spaced ` · ` separators
- Join the quota bar and reset label without an intervening space
- Show reset labels as local `↻HH:mm` through 24 hours, remaining whole days/hours above 24 hours (e.g., `↻1d8h`), and whole days above 10 days (e.g., `↻12d`)
- Grow the quota bar from five to ten cells using spare footer columns, improving steps from 2.5% to 1.25% without shortening other fields; retain the smaller fallback on very narrow terminals

## [0.2.0] - 2026-10-05

### Added

- Usage limits for the selected provider: OpenAI Codex, Claude OAuth, GitHub Copilot, Gemini CLI, MiniMax (global/CN), Kimi Coding, and OpenCode Go
- Show the shortest available quota window, including weekly/monthly when no shorter quota exists; omit reset time when the provider does not report it
- Compact five-cell Braille quota bar with nine bottom-up fill states (`⠀`, `⡀`, `⣀`, `⣄`, `⣤`, `⣦`, `⣶`, `⣷`, `⣿`), 2.5% steps, and green/amber/red usage colors
- Absolute local reset time marked with `↻` in 24-hour format, e.g. `⣿⣶⠀⠀⠀ ↻16:40`, without provider/window labels or numeric percentages
- Passive Codex/Claude quota updates from provider responses, with four-minute usage-endpoint fallback and reset-time refresh using Pi's existing credentials
- Immediate quota clearing and request/timer cancellation on provider switch; ignore late results and dim only the current provider's cached quota after temporary refresh failures
- Hide usage for local/unsupported models, missing credentials, or absent applicable limits; stop quota work on footer teardown, disable, and session shutdown
- README examples and documentation for the complete usage feature, its shading, reset time, refresh behavior, and edge cases
- Honorable mention to Can Celik (@ogulcancelik): provider usage-fetching and quota-parsing logic copied and adapted from [@ogulcancelik/pi-minimal-footer](https://pi.dev/packages/@ogulcancelik/pi-minimal-footer), with upstream MIT attribution retained

### Changed

- Group directory and git branch on the left; keep extension statuses, model, context, and quota on the right in one line, with extra spacing before quota
- Shorten location and statuses on narrow terminals, shrink quota before truncating model/context, and preserve the reset time
- Simplify quota header parsing and footer width calculations; remove the unused duplicate Claude header parser

### Fixed

- Release stalled quota authentication, fetch, and response-body waits after five seconds so scheduled polling can recover; ignore late results after timeout or provider switch
- Merge partial Codex/Claude quota signals without replacing a cached shorter window or postponing its four-minute refresh when only longer windows update
- Preserve dim cached usage after malformed responses, while explicit empty/unlimited quotas clear it; retain valid usage when optional reset metadata is invalid
- Accept Kimi used-only quotas and week/month durations, and derive Codex reset times from relative endpoint delays when an absolute timestamp is unavailable
- Clear cached quota when Pi reports missing credentials; retain dim cached usage for temporary authentication failures and recover after credentials are restored

## [0.1.3] - 2026-10-05

### Added

- Strict TypeScript type checking for the Pi extension

### Changed

- Refresh README and package-gallery screenshots with Pi 1.0.3 and the current minimal footer
- Refresh context after persisted turns, final agent settlement, compaction, and session-tree navigation without reinstalling the footer on each event
- Read `minFooter` from Pi's configured agent directory at session start or explicit toggle; retain unrelated settings
- On narrow terminals, shrink/drop the path, then extension statuses, then git branch before truncating model/context

### Fixed

- Preserve right alignment on narrow terminals after dropping extension statuses or git branch, including truncated model/context
- Avoid stale branch subscriptions and render references after footer teardown
- Abbreviate home only for the exact home path or its children
- Show the custom footer only in terminal UI mode
- Clarify that `showSkills` displays extension statuses, not installed skills

## [0.1.2] - 2026-09-01

### Changed

- Updated the Node.js engine declaration to match current Pi releases (`>=22.19.0`)
- README polish: remove internal API jargon, fix `e.g.,` comma, tighten config section

### Fixed

- Keep merged footer settings non-optional so the extension passes strict TypeScript checks
- Footer no longer overflows on narrow terminal windows — truncate the path (then the right side) to fit the terminal width using pi-tui's `truncateToWidth`, instead of emitting a line wider than the terminal (which crashed pi)

## [0.1.1] - 2026-06-15

### Added

- Preview screenshot (`preview.png`) and `pi.image` gallery metadata for pi.dev/packages
- README badges: npm version, downloads, and license
- Screenshot preview rendered directly in README

### Changed

- Model and context usage rendered in **bold** for better at-a-glance scanning
- README tagline tightened to "A clean, compact one-line footer for pi."

### Fixed

- Skills segment no longer shows trailing `|` separator when one skill has an empty status value

## [0.1.0] - 2026-06-15

First npm-ready release.

### Added

- Minimal footer extension for pi — replaces the default footer with a clean, compact status line
- **Working directory** segment — shows relative path from home (`~/...`)
- **Active skills** segment — shows extension statuses
- **Git branch** segment — current branch with Nerd Fonts icon (``)
- **Model** segment — active model ID
- **Context usage** segment — tokens used / context window (e.g. `12/128k`)
- **Configuration** — all segments individually toggleable via `~/.pi/agent/settings.json`
- **`/minfooter` command** — toggle the extension on/off from chat
- MIT License

### Changed

- Context usage display deduplicates `k`/`M` suffix — shows `4/200k` instead of `4k/200k`
- Context usage format removes spaces around `/` separator
- README updated with Nerd Fonts git icon and npm install instructions
- Package metadata expanded for npm release (`author`, `files`, `engines`, `keywords`, `homepage`, `bugs`)

## [0.0.0] - 2026-06-13

### Added

- Project scaffold — `extensions/index.ts` with basic footer structure, `package.json` with pi extension manifest, `README.md`, `LICENSE` (MIT)

[Unreleased]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.0.0...v0.1.0
[0.0.0]: https://github.com/Ryu-CZ/pi-minimal-footer/releases/tag/v0.0.0
