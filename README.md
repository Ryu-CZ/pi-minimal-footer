# pi-minimal-footer

A minimal footer extension for [pi](https://github.com/earendil-works/pi-coding-agent) that replaces the default footer with a clean status line:

```
~/path/to/dir                      (skill1 | skill2)  git-branch  model  12k / 128k
```

## Install

```bash
# From git
pi install git:github.com/Ryu-CZ/pi-minimal-footer

# Or manually
cp -r extensions ~/.pi/agent/extensions/
```

## Features

- **Working directory** — relative path from home (`~/...`)
- **Active skills** — extension statuses from `ctx.ui.setStatus()`
- **Git branch** — current branch name
- **Model** — active model ID
- **Context usage** — tokens used / context window

## Commands

| Command | Description |
|---|---|
| `/minfooter` | Toggle on/off |
| `/minfooter on` | Force enable |
| `/minfooter off` | Force disable |

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

You can edit `~/.pi/agent/settings.json` directly or use the `/minfooter` command to toggle.
