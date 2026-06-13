# pi-minimal-footer

A minimal footer extension for [pi](https://github.com/earendil-works/pi-coding-agent) that replaces the default footer with a clean status line:

```
~/path/to/dir                      (skill1 | skill2)  model  context_used / context_size
```

## Install

Copy `minimal-footer.ts` into your pi extensions directory:

```bash
cp minimal-footer.ts ~/.pi/agent/extensions/
```

## Commands

- `/minfooter` — toggle on/off
- `/minfooter on` — force enable
- `/minfooter off` — force disable

Settings are persisted in `~/.pi/agent/settings.json` under the `minFooter` key.
