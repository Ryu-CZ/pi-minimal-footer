/**
 * Minimal footer — replaces pi's default footer with a clean status line:
 *
 *   /full/path                      (skill1 | skill2)  model  context_used / context_size
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
  minFooter?: { enabled?: boolean };
}

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
    const merged: Settings = {
      ...current,
      ...patch,
    };
    writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
  } catch {
    // best-effort
  }
}

function readEnabled(): boolean {
  const s = readSettings();
  return s.minFooter?.enabled !== false; // default to true
}

function writeEnabled(v: boolean): void {
  const s = readSettings();
  s.minFooter = { ...s.minFooter, enabled: v };
  writeSettings(s);
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
let state = {
  cwd: process.cwd(),
  model: "no-model",
  context: "?",
  footerData: null as ReadonlyFooterDataProvider | null,
};

function updateState(ctx: ExtensionContext): void {
  state.cwd = ctx.cwd ?? process.cwd();
  state.model = ctx.model?.id ?? "no-model";
  const usage = ctx.getContextUsage();
  state.context = usage
    ? `${formatSize(usage.tokens)} / ${formatSize(usage.contextWindow)}`
    : "?";
}

function buildLeft(): string {
  const home = homedir();
  if (state.cwd.startsWith(home)) {
    return "~" + state.cwd.slice(home.length);
  }
  return state.cwd;
}

function buildRight(): string {
  let skills = "";
  if (state.footerData) {
    const statuses = state.footerData.getExtensionStatuses();
    if (statuses.size > 0) {
      skills = "(" + [...statuses.values()].join(" | ") + ")  ";
    }
  }
  return `${skills}${state.model}  ${state.context}`;
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  function setFooter(ctx: ExtensionContext): void {
    updateState(ctx);

    if (!ctx.hasUI) return;

    if (enabled) {
      ctx.ui.setFooter((tui, theme, footerData) => {
        state.footerData = footerData;

        return {
          render(width: number): string[] {
            const left = buildLeft();
            const right = buildRight();
            const leftW = visibleWidth(left);
            const rightW = visibleWidth(right);
            const gap = Math.max(1, width - leftW - rightW);
            const spacer = " ".repeat(gap);
            const line = theme.fg("dim", `${left}${spacer}${right}`);
            return [line];
          },
          invalidate(): void {},
          dispose: () => {}, // no reactive onStatusChange hook; lifecycle events trigger re-render
        };
      });
    } else {
      ctx.ui.setFooter(undefined);
    }
  }

  // ── Lifecycle events ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    enabled = readEnabled(); // pick up any external edits
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
