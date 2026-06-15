# pi-minimal-footer

A minimal footer extension for [pi](https://github.com/earendil-works/pi-coding-agent) that replaces the default footer with a clean, compact status line:

```
~/path/to/dir                (skill1 | skill2)   main  sonnet  12/128k
```

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
- **Active skills** — extension statuses from `ctx.ui.setStatus()`
- **Git branch** — current branch name
- **Model** — active model ID
- **Context usage** — tokens used / context window (e.g. `12/128k`)

## Commands

| Command | Description |
|---|---|
| `/minfooter` | Toggle the extension on/off |
| `/minfooter on` | Enable |
| `/minfooter off` | Disable |

> The `/minfooter` command only controls the `enabled` setting. To tweak individual segments (path, model, etc.), edit `~/.pi/agent/settings.json` directly.

## Configuration

Settings are persisted in `~/.pi/agent/settings.json` under the `minFooter` key:

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

Edit the file directly to show or hide individual segments. The `/minfooter` command is a shortcut that toggles only the `enabled` flag.
