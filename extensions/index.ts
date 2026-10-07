/**
 * Minimal footer — replaces pi's default footer with a clean status line:
 *
 *   ~/path/to/dir   main        status1  status2  sonnet · 12/128k · [⣿⣶⠀⠀⠀]↻16:40
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
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { BASE_BAR_CELLS, MAX_BAR_CELLS, UsageLimits } from "./lib/usage-limits.js";

// ── Settings ──────────────────────────────────────────────────────────

interface Settings {
  minFooter?: {
    enabled?: boolean;
    showGitBranch?: boolean;
    showSkills?: boolean;
    showPath?: boolean;
    showModel?: boolean;
    showContext?: boolean;
    powerlineSeparator?: boolean;
    maxUsageBarCells?: number;
  };
}

type FooterSettings = NonNullable<Settings["minFooter"]>;

const execFileAsync = promisify(execFile);

const DEFAULT_SETTINGS: FooterSettings = {
  enabled: true,
  showGitBranch: true,
  showSkills: true,
  showPath: true,
  showModel: true,
  showContext: true,
  powerlineSeparator: true,
  maxUsageBarCells: MAX_BAR_CELLS,
};

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readSettings(): Settings {
  try {
    if (!existsSync(settingsPath())) return {};
    const settings: unknown = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    // Valid JSON can still be null or a scalar; a broken preference file must not prevent loading.
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return {};
    return settings as Settings;
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
    // A read-only settings file must not crash the extension.
  }
}

function readConfig(): FooterSettings {
  const s = readSettings();
  const config = { ...DEFAULT_SETTINGS, ...s.minFooter };
  if (typeof config.maxUsageBarCells !== "number" || !Number.isSafeInteger(config.maxUsageBarCells) || config.maxUsageBarCells < 1) {
    config.maxUsageBarCells = MAX_BAR_CELLS;
  }
  return config;
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
  gitSync: string;
}

async function getGitSync(cwd: string): Promise<string> {
  try {
    // Pi exposes the branch name, but not upstream divergence. Keep this
    // asynchronous and outside render() so a slow Git repository cannot block TUI rendering.
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"], {
      timeout: 1000,
      maxBuffer: 1024,
    });
    // With HEAD...@{upstream}, left is local-only commits (push) and right
    // is upstream-only commits (pull). An absent upstream is intentionally hidden.
    const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return "";
    return `${ahead ? ` ↑${ahead}` : ""}${behind ? ` ↓${behind}` : ""}`;
  } catch {
    // No repository, upstream, or reachable Git command: omit sync status.
    return "";
  }
}

async function updateGitSync(state: FooterState): Promise<void> {
  const cwd = state.cwd;
  const gitSync = await getGitSync(cwd);
  if (state.cwd === cwd) state.gitSync = gitSync;
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
// Keep the usage bar and reset time together; shorten location/statuses before model/context.
// All segment measurements use visible widths, including ANSI and wide characters.

const MODEL_GAP = " · ";
const USAGE_GAP = " · ";
const LOCATION_GAP_WIDTH = 3;
// Below these budgets, ellipses dominate text and status tabs stop being useful at a glance.
const MIN_TEXT_WIDTH = 4;
const MIN_STATUS_WIDTH = 12;

function buildLine(
  width: number, path: string, statuses: string, branch: string, model: string, context: string,
  usage: (available: number, maxCells?: number) => string | null,
  statusSeparator: string, locationSeparator: string, maxUsageBarCells: number,
): string {
  if (width <= 0) return "";
  if (width <= 2) return " ".repeat(width);
  width -= 2;
  let core = [model, context].filter(Boolean).join(MODEL_GAP);
  // Budget the compact bar first; its expanded size must not drive truncation decisions.
  const usageBar = usage(width, Math.min(BASE_BAR_CELLS, maxUsageBarCells)) ?? "";
  const usageGapWidth = usageBar && core ? USAGE_GAP.length : 0;
  const coreBudget = Math.max(0, width - visibleWidth(usageBar) - usageGapWidth);
  if (usageBar && coreBudget < MIN_TEXT_WIDTH) {
    core = "";
  } else if (visibleWidth(core) > coreBudget) {
    const modelGapWidth = model && context ? MODEL_GAP.length : 0;
    const modelBudget = coreBudget - visibleWidth(context) - modelGapWidth;
    if (modelBudget > 0) {
      core = [truncateToWidth(model, modelBudget, "..."), context].filter(Boolean).join(MODEL_GAP);
    } else {
      core = truncateToWidth(context || model, coreBudget, "...");
    }
  }
  const protectedRight = [core, usageBar].filter(Boolean).join(USAGE_GAP);
  const branchReservation = branch ? visibleWidth(branch) + LOCATION_GAP_WIDTH : 0;
  const statusBudget = width - visibleWidth(protectedRight) - branchReservation - visibleWidth(statusSeparator);
  let fittedStatuses = "";
  if (statusBudget >= MIN_STATUS_WIDTH) {
    fittedStatuses = statuses;
    if (visibleWidth(statuses) > statusBudget) {
      fittedStatuses = truncateToWidth(statuses, statusBudget, "...");
    }
  }
  let right = [fittedStatuses, protectedRight].filter(Boolean).join(statusSeparator);
  const reservedLocationGapWidth = right ? LOCATION_GAP_WIDTH : 0;
  const leftBudget = Math.max(0, width - visibleWidth(right) - reservedLocationGapWidth);
  const fittedBranch = visibleWidth(branch) <= leftBudget ? branch : "";
  const pathGapWidth = fittedBranch && path ? visibleWidth(locationSeparator) : 0;
  const pathBudget = leftBudget - visibleWidth(fittedBranch) - pathGapWidth;
  const fittedPath = pathBudget >= MIN_TEXT_WIDTH ? truncateToWidth(path, pathBudget, "...") : "";
  const left = [fittedPath, fittedBranch].filter(Boolean).join(locationSeparator);
  if (usageBar) {
    // A dropped left group needs no divider; those columns belong to the usage bar instead.
    const interGroupGapWidth = left && right ? LOCATION_GAP_WIDTH : 0;
    const spareWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(right) - interGroupGapWidth);
    const expandedUsageBar = usage(visibleWidth(usageBar) + spareWidth, maxUsageBarCells) ?? usageBar;
    const expandedCore = [core, expandedUsageBar].filter(Boolean).join(USAGE_GAP);
    right = [fittedStatuses, expandedCore].filter(Boolean).join(statusSeparator);
  }
  return " " + left + " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right))) + right + " ";
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config = readConfig();
  let enabled = config.enabled !== false;
  const state: FooterState = { cwd: process.cwd(), model: "no-model", context: "?", gitSync: "" };
  let requestRender: (() => void) | null = null;
  let disposeFooter: (() => void) | null = null;
  const usageLimits = new UsageLimits(() => requestRender?.());

  function selectUsage(ctx: ExtensionContext): void {
    // The preference may remain enabled after another extension replaces our footer.
    // Poll only while we own a live renderer, or model changes can resurrect hidden requests.
    usageLimits.select(ctx, enabled && disposeFooter !== null);
  }

  function install(ctx: ExtensionContext): void {
    config = readConfig();
    enabled = config.enabled !== false;
    if (ctx.mode !== "tui") { usageLimits.stop(); return; }

    if (!enabled) {
      usageLimits.stop();
      if (disposeFooter) ctx.ui.setFooter(undefined);
      return;
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      // Branch changes are Pi's invalidation signal; refresh the async Git
      // divergence separately because footer rendering must remain synchronous.
      const unsub = footerData.onBranchChange(() => {
        void updateGitSync(state).then(() => tui.requestRender());
        tui.requestRender();
      });
      const request = () => tui.requestRender();
      requestRender = request;
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsub();
        // A superseded renderer must not stop its replacement's usage polling.
        if (requestRender === request) {
          requestRender = null;
          usageLimits.stop();
        }
        if (disposeFooter === dispose) disposeFooter = null;
      };
      disposeFooter = dispose;

      return {
        render(width: number): string[] {
          const statuses = config.showSkills
            ? [...footerData.getExtensionStatuses().values()].filter((s) => s.trim())
            : [];
          const branch = config.showGitBranch ? footerData.getGitBranch() : null;
          const branchText = branch ? `${branch}${state.gitSync}` : "";
          const statusSeparator = config.powerlineSeparator ? theme.fg("dim", "  ") : " ";
          const line = buildLine(
            width,
            config.showPath ? theme.fg("dim", abbreviateHome(state.cwd, homedir())) : "",
            statuses.length ? statusSeparator + statuses.map((status) => theme.fg("dim", status)).join(statusSeparator) : "",
            branchText ? theme.fg("dim", ` ${branchText}`) : "",
            config.showModel ? theme.bold(state.model) : "",
            config.showContext ? theme.fg("dim", theme.bold(state.context)) : "",
            (available, maxCells = BASE_BAR_CELLS) => usageLimits.line(available, theme, maxCells),
            statusSeparator,
            config.powerlineSeparator ? theme.fg("dim", "  ") : " ",
            config.maxUsageBarCells ?? MAX_BAR_CELLS,
          );
          return [line];
        },
        invalidate(): void {},
        dispose,
      };
    });
    selectUsage(ctx);
  }

  /** Cheap refresh: update plain state and request one render. */
  function refresh(ctx: ExtensionContext): void {
    updateState(ctx, state);
    void updateGitSync(state).then(() => requestRender?.());
    requestRender?.();
  }

  // ── Lifecycle events (passive; no footer re-install) ────────────────

  pi.on("session_start", async (_event, ctx) => {
    usageLimits.stop();
    refresh(ctx);
    install(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    selectUsage(ctx);
    refresh(ctx);
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model) usageLimits.headers(ctx.model.provider, event.headers);
  });

  pi.on("provider_stream_event", (event) => {
    usageLimits.stream(event.provider, event.model, event.data);
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
    usageLimits.stop();
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
