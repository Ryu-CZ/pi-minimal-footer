/**
 * Minimal footer — replaces pi's default footer with a clean status line:
 *
 *   ~/path/to/dir                (skill1 | skill2)   main  sonnet  12k / 128k
 *
 * Settings are persisted in ~/.pi/agent/settings.json under "minFooter".
 *
 * Commands:
 *   /minfooter          — toggle on/off
 *   /minfooter on|off   — force state
 */

import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
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

const DEFAULT_SETTINGS: Settings["minFooter"] = {
  enabled: true,
  showGitBranch: true,
  showSkills: true,
  showPath: true,
  showModel: true,
  showContext: true,
};

function settingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
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

function readEnabled(): boolean {
  const s = readSettings();
  return s.minFooter?.enabled !== false; // default to true
}

function readConfig(): Settings["minFooter"] {
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

// ── State ─────────────────────────────────────────────────────────────

let enabled = readEnabled();
let config = readConfig();
let state = {
  cwd: process.cwd(),
  model: "no-model",
  context: "?",
  branch: "",
  footerData: null as ReadonlyFooterDataProvider | null,
};

function updateState(ctx: ExtensionContext): void {
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

// ── Footer builders ───────────────────────────────────────────────────

function buildLeft(): string {
  if (!config.showPath) return "";
  const home = homedir();
  if (state.cwd.startsWith(home)) {
    return "~" + state.cwd.slice(home.length);
  }
  return state.cwd;
}

function buildRight(footerData: ReadonlyFooterDataProvider): string {
  const segments: string[] = [];

  if (config.showSkills) {
    const statuses = footerData.getExtensionStatuses();
    const skillNames = [...statuses.values()].filter(s => s.trim());
    if (skillNames.length > 0) {
      segments.push("(" + skillNames.join(" | ") + ")");
    }
  }

  if (config.showGitBranch) {
    const branch = footerData.getGitBranch();
    if (branch) segments.push(` ${branch}`);
  }

  if (config.showModel) {
    segments.push(state.model);
  }

  if (config.showContext) {
    segments.push(state.context);
  }

  return segments.join("  ");
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  function setFooter(ctx: ExtensionContext): void {
    updateState(ctx);
    config = readConfig(); // re-read on each set

    if (!ctx.hasUI) return;

    if (enabled) {
      ctx.ui.setFooter((tui, theme, footerData) => {
        state.footerData = footerData;

        const unsub = footerData.onBranchChange(() => tui.requestRender());

        return {
          render(width: number): string[] {
            const left = buildLeft();
            const right = buildRight(footerData);
            const leftW = visibleWidth(left);
            const rightW = visibleWidth(right);
            const gap = Math.max(1, width - leftW - rightW);
            const spacer = " ".repeat(gap);
            const line = theme.fg("dim", `${left}${spacer}${right}`);
            return [line];
          },
          invalidate(): void {},
          dispose: unsub,
        };
      });
    } else {
      ctx.ui.setFooter(undefined);
    }
  }

  // ── Lifecycle events ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    enabled = readEnabled();
    setFooter(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    setFooter(ctx);
  });

  pi.on("message_end", async (_event, ctx) => {
    setFooter(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    setFooter(ctx);
  });

  // ── Command ─────────────────────────────────────────────────────────

  pi.registerCommand("minfooter", {
    description: "Toggle minimal footer",
    handler: async (args, ctx) => {
      if (args === "on") enabled = true;
      else if (args === "off") enabled = false;
      else enabled = !enabled;
      writeEnabled(enabled);
      setFooter(ctx);
      ctx.ui.notify(`Minimal footer ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
