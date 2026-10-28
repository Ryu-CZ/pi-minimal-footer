/**
 * Minimal footer — replaces pi's default footer with a clean status line:
 *
 *   ~/path/to/dir   main        status1  status2  sonnet · 12k/128k · [⣿⣶⠀⠀⠀]↻16:40
 *
 * Settings are persisted in the agent directory (usually ~/.pi/agent)
 * settings.json under "minFooter".
 *
 * Commands:
 *   /minfooter          — toggle on/off
 *   /minfooter on|off   — force state
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sep } from "node:path";
import { homedir } from "node:os";
import { BASE_BAR_CELLS, MAX_BAR_CELLS, UsageLimits } from "./lib/usage-limits.js";
import { readConfig, writeEnabled, type FooterSettings } from "./lib/footer-settings.js";
import { buildLine } from "./lib/footer-layout.js";
import { GitStatus } from "./lib/git-status.js";

// ── Formatting helpers ────────────────────────────────────────────────

function formatPercentage(tokens: number | null | undefined, contextWindow: number): string {
  if (tokens == null || contextWindow <= 0) return "?";
  return `${(tokens / contextWindow * 100).toFixed(1)}%`;
}

function formatSize(n: number | null | undefined): string {
  if (n == null) return "?";
  const kilos = n / 1_000;
  if (n === 0 || n >= 10_000) return `${Math.round(kilos)}k`;
  const rounded = Number(kilos.toPrecision(2));
  const decimals = Math.min(3, Math.max(0, 1 - Math.floor(Math.log10(rounded))));
  return `${rounded.toFixed(decimals)}k`;
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

function updateState(ctx: ExtensionContext, state: FooterState, config: FooterSettings, git: GitStatus): void {
  const cwd = ctx.cwd ?? process.cwd();
  state.cwd = cwd;
  git.setCwd(cwd);
  state.model = ctx.model?.id ?? "no-model";
  const usage = ctx.getContextUsage();
  if (usage) {
    const fTokens = config.contextAsPercentage === true
      ? formatPercentage(usage.tokens, usage.contextWindow)
      : formatSize(usage.tokens);
    const fWindow = formatSize(usage.contextWindow);
    state.context = `${fTokens}/${fWindow}`;
  } else {
    state.context = "?";
  }
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config = readConfig();
  let enabled = config.enabled !== false;
  let currentCtx: ExtensionContext | undefined;
  const state: FooterState = { cwd: process.cwd(), model: "no-model", context: "?" };
  const git = new GitStatus(state.cwd);
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
    updateState(ctx, state, config, git);
    if (ctx.mode !== "tui") { usageLimits.stop(); return; }

    if (!enabled) {
      usageLimits.stop();
      if (disposeFooter) ctx.ui.setFooter(undefined);
      return;
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      // Branch changes are Pi's invalidation signal; refresh the async Git
      // divergence separately because footer rendering must remain synchronous.
      const request = () => {
        if (requestRender === request) tui.requestRender();
      };
      requestRender = request;
      const unsub = footerData.onBranchChange(() => {
        if (requestRender !== request) return;
        void git.refresh().then(request);
        request();
      });
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsub();
        // A superseded renderer must not stop its replacement's background work.
        if (disposeFooter === dispose) {
          git.stop();
          requestRender = null;
          usageLimits.stop();
          disposeFooter = null;
        }
      };
      disposeFooter = dispose;
      git.start(config, request);

      return {
        render(width: number): string[] {
          const statuses = config.showSkills
            ? [...footerData.getExtensionStatuses().values()].map((s) => s.replace(/[\r\n\t]/g, " ")).filter((s) => s.trim())
            : [];
          const branch = config.showGitBranch ? footerData.getGitBranch() : null;
          const branchText = branch ? ` ${branch}${git.sync}` : "";
          const gitText = git.highlighted ? theme.bold(branchText) : branchText;
          const statusSeparator = config.powerlineSeparator ? theme.fg("dim", "  ") : " ";
          const line = buildLine({
            width,
            path: config.showPath ? theme.fg("dim", abbreviateHome(state.cwd, homedir())) : "",
            statuses: statuses.length ? statusSeparator + statuses.map((status) => theme.fg("dim", status)).join(statusSeparator) : "",
            // Pulse weight independently of the existing divergence color.
            branch: branchText ? theme.fg(git.sync ? "text" : "dim", gitText) : "",
            model: config.showModel ? theme.bold(state.model) : "",
            context: config.showContext ? theme.fg("dim", theme.bold(state.context)) : "",
            usage: (available, maxCells = BASE_BAR_CELLS) => usageLimits.line(available, theme, maxCells),
            statusSeparator,
            locationSeparator: config.powerlineSeparator ? theme.fg("dim", "  ") : " ",
            maxUsageBarCells: config.maxUsageBarCells ?? MAX_BAR_CELLS,
          });
          return [line];
        },
        invalidate(): void {},
        dispose,
      };
    });
    selectUsage(ctx);
  }

  /** Gate active work on a live footer so passive state updates cannot resurrect hidden Git queries. */
  function refreshFooter(): void {
    if (disposeFooter === null) return;
    void git.refresh().then(() => requestRender?.());
    requestRender?.();
  }

  function refresh(ctx: ExtensionContext): void {
    updateState(ctx, state, config, git);
    refreshFooter();
  }

  // ── Lifecycle events (passive; no footer re-install) ────────────────

  pi.events.on("pi-minimal-footer:set-enabled", (data) => {
    if (!currentCtx || typeof data !== "object" || data === null ||
        !("enabled" in data) || typeof data.enabled !== "boolean") return;
    if (enabled === data.enabled && (!enabled || disposeFooter !== null)) return;
    enabled = data.enabled;
    install(currentCtx);
    refreshFooter();
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    config = readConfig();
    enabled = config.enabled !== false;
    usageLimits.stop();
    install(ctx);
    refreshFooter();
  });

  pi.on("input", (_event, ctx) => {
    refresh(ctx);
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
    currentCtx = undefined;
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
      install(ctx);
      refreshFooter();
      ctx.ui.notify(`Minimal footer ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });
}
