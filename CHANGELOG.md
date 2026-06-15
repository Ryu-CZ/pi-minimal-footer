# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Ryu-CZ/pi-minimal-footer/compare/v0.0.0...v0.1.0
[0.0.0]: https://github.com/Ryu-CZ/pi-minimal-footer/releases/tag/v0.0.0
