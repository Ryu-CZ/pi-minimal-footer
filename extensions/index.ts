/**
 * Minimal footer — replaces pi's default footer with a clean status line:
 *
 *   ~/path/to/dir                (skill1 | skill2)   main  sonnet  12/128k
 *
 * Settings are persisted in the agent directory (usually ~/.pi/agent)
 * settings.json under "minFooter".
 *
 * Commands:
 *   /minfooter          — toggle on/off
 *   /minfooter on|off   — force state
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";

// ── Settings ──────────────────────────────────────────────────────────

interface Settings {
  minFooter?: {
    enabled?: boolean;
    showGitBranch?: boolean;
    showSkills?: boolean;
    showPath?: boolean;
    showModel?: boolean;
    showContext?: boolean;
  };
}

type FooterSettings = NonNullable<Settings["minFooter"]>;

const DEFAULT_SETTINGS: FooterSettings = {
  enabled: true,
  showGitBranch: true,
  showSkills: true,
  showPath: true,
  showModel: true,
  showContext: true,
};

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readSettings(): Settings {
  try {
    if (!existsSync(settingsPath())) return {};
    return JSON.parse(readFileSync(settingsPath(), "utf-8")) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(patch: Partial<Settings>): void {
  try {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    const current = readSettings();
    writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
  } catch {
    // best-effort
  }
}

function readConfig(): FooterSettings {
  const s = readSettings();
  return { ...DEFAULT_SETTINGS, ...s.minFooter };
}

function writeEnabled(v: boolean): void {
  const cfg = readConfig();
  cfg.enabled = v;
  writeSettings({ minFooter: cfg });
}

// ── Formatting helpers ────────────────────────────────────────────────

function formatSize(n: number | null | undefined): string {
  if (n == null) return "?";
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Abbreviate only an exact home match or a boundary-prefixed child path. */
function abbreviateHome(p: string, home: string): string {
  if (p === home) return "~";
  if (p.startsWith(home + sep)) return "~" + p.slice(home.length);
  return p;
}

// ── State ─────────────────────────────────────────────────────────────

interface FooterState {
  cwd: string;
  model: string;
  context: string;
}

function updateState(ctx: ExtensionContext, state: FooterState): void {
  state.cwd = ctx.cwd ?? process.cwd();
  state.model = ctx.model?.id ?? "no-model";
  const usage = ctx.getContextUsage();
  if (usage) {
    const fTokens = formatSize(usage.tokens);
    const fWindow = formatSize(usage.contextWindow);
    const lastT = fTokens[fTokens.length - 1];
    const lastW = fWindow[fWindow.length - 1];
    // Deduplicate k/M suffix: show suffix only on denominator when both use the same unit
    if ((lastT === "k" || lastT === "M") && lastT === lastW) {
      state.context = `${fTokens.slice(0, -1)}/${fWindow}`;
    } else {
      state.context = `${fTokens}/${fWindow}`;
    }
  } else {
    state.context = "?";
  }
}

// ── Layout ────────────────────────────────────────────────────────────
//
// Priority when space runs out:
//   1. drop/truncate the path first (truncate, then drop entirely)
//   2. drop extension statuses
//   3. drop the git branch
//   4. retain model/context as long as possible
//   5. last resort: truncate the remaining model/context to fit
//
// Every returned line is guaranteed to fit `width` (visible-width safe).

function buildLine(width: number, path: string, statuses: string, branch: string, model: string, context: string): string {
  if (width <= 0) return "";
  const core = [model, context].filter(Boolean).join("  ");
  const right = [statuses, branch, core].filter(Boolean).join("  ");
  const rightWidth = visibleWidth(right);

  if (rightWidth < width) {
    const left = path ? truncateToWidth(path, width - rightWidth - 1, "...", true) : " ".repeat(width - rightWidth - 1);
    return `${left} ${right}`;
  }

  // Drop the path, then extension statuses, then git; protect model/context until last.
  let remaining = right;
  if (rightWidth > width) remaining = [branch, core].filter(Boolean).join("  ");
  if (visibleWidth(remaining) > width) remaining = core;
  remaining = truncateToWidth(remaining, width, "...");
  return " ".repeat(width - visibleWidth(remaining)) + remaining;
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config = readConfig();
  let enabled = config.enabled !== false;
  const state: FooterState = { cwd: process.cwd(), model: "no-model", context: "?" };
  let requestRender: (() => void) | null = null;
  let disposeFooter: (() => void) | null = null;

  function install(ctx: ExtensionContext): void {
    config = readConfig();
    enabled = config.enabled !== false;
    if (ctx.mode !== "tui") return;

    if (!enabled) {
      if (disposeFooter) ctx.ui.setFooter(undefined);
      return;
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      const request = () => tui.requestRender();
      requestRender = request;
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsub();
        if (requestRender === request) requestRender = null;
        if (disposeFooter === dispose) disposeFooter = null;
      };
      disposeFooter = dispose;

      return {
        render(width: number): string[] {
          const skills = config.showSkills
            ? [...footerData.getExtensionStatuses().values()].filter((s) => s.trim())
            : [];
          const branch = config.showGitBranch ? footerData.getGitBranch() : null;
          const line = buildLine(
            width,
            config.showPath ? abbreviateHome(state.cwd, homedir()) : "",
            skills.length ? `(${skills.join(" | ")})` : "",
            branch ? ` ${branch}` : "",
            config.showModel ? theme.bold(state.model) : "",
            config.showContext ? theme.bold(state.context) : "",
          );
          return [theme.fg("dim", line)];
        },
        invalidate(): void {},
        dispose,
      };
    });
  }

  /** Cheap refresh: update plain state and request one render. */
  function refresh(ctx: ExtensionContext): void {
    updateState(ctx, state);
    requestRender?.();
  }

  // ── Lifecycle events (passive; no footer re-install) ────────────────

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx);
    install(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_shutdown", async () => {
    disposeFooter?.();
  });

  // ── Command ─────────────────────────────────────────────────────────

  pi.registerCommand("minfooter", {
    description: "Toggle minimal footer",
    handler: async (args, ctx) => {
      if (args === "on") enabled = true;
      else if (args === "off") enabled = false;
      else enabled = !enabled;
      writeEnabled(enabled);
      refresh(ctx);
      install(ctx);
      ctx.ui.notify(`Minimal footer ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
