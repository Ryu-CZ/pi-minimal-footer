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

A clean, compact one-line footer for [pi](https://github.com/earendil-works/pi) — [available on the pi package gallery](https://pi.dev/packages/pi-minimal-footer).

```
~/path/to/dir                (skill1 | skill2)   main  sonnet  12/128k
```

![pi-minimal-footer screenshot](media/github-preview.png)

## Install

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

## Features

- **Working directory** — relative path from home (`~/...`)
- **Active skills** — extensions reporting their current status
- **Git branch** — current branch name
- **Model** — active model ID
- **Context usage** — tokens used / context window (e.g., `12/128k`)

## Commands

| Command | Description |
|---|---|
| `/minfooter` | Toggle the extension on/off |
| `/minfooter on` | Enable |
| `/minfooter off` | Disable |

> The `/minfooter` command only toggles the `enabled` flag. To show or hide individual segments, edit `~/.pi/agent/settings.json` directly.

## Configuration

Settings live in `~/.pi/agent/settings.json` under the `minFooter` key:

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
