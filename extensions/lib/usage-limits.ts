// Usage logic copied and adapted from https://pi.dev/packages/@ogulcancelik/pi-minimal-footer.
// Copyright (c) 2025 Can Celik. MIT license: ./LICENSE.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import { parseUsageWindows, record, shortest, supportedOrigin, usageRequest, windowFrom } from "./quota-providers.js";
import type { QuotaWindow } from "./quota-providers.js";

const REFRESH_MS = 4 * 60_000;

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Usage request aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // Observe late failures even after abort has settled the caller's await.
    promise.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function passiveNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return NaN;
}

function passiveWindow(used: unknown, seconds: number | undefined, reset: unknown, cached: QuotaWindow | undefined): QuotaWindow | null {
  const window = windowFrom(used, seconds === undefined ? cached?.seconds : seconds, reset);
  // Omitted metadata belongs to the same window only while its duration agrees.
  if (window && reset === undefined && window.seconds === cached?.seconds) window.resetAt = cached.resetAt;
  return window;
}

function fromHeaders(provider: string, headers: Record<string, string>, cached: Record<string, QuotaWindow>): Record<string, QuotaWindow> {
  const windows: Record<string, QuotaWindow> = {};
  let definitions: readonly (readonly [string, string, number?])[];
  if (provider === "openai-codex") {
    definitions = [["primary", "primary"], ["secondary", "secondary"]];
  } else if (provider === "anthropic") {
    definitions = [["five_hour", "5h", 18000], ["seven_day", "7d", 604800]];
  } else {
    return windows;
  }
  const codex = provider === "openai-codex";
  const usedSuffix = codex ? "used-percent" : "utilization";
  const resetSuffix = codex ? "reset-at" : "reset";
  for (const [key, name, defaultSeconds] of definitions) {
    const prefix = codex ? `x-codex-${name}` : `anthropic-ratelimit-unified-${name}`;
    const used = passiveNumber(headers[`${prefix}-${usedSuffix}`]) * (codex ? 1 : 100);
    const durationKey = `${prefix}-window-minutes`;
    const resetKey = `${prefix}-${resetSuffix}`;
    const seconds = Object.hasOwn(headers, durationKey) ? passiveNumber(headers[durationKey]) * 60 : defaultSeconds;
    const reset = Object.hasOwn(headers, resetKey) ? passiveNumber(headers[resetKey]) : undefined;
    const window = passiveWindow(used, seconds, reset, cached[key]);
    if (window) windows[key] = window;
  }
  return windows;
}

function fromStream(data: unknown, cached: Record<string, QuotaWindow>): Record<string, QuotaWindow> {
  const event = record(data);
  if (event.type !== "codex.rate_limits") return {};
  // Other metered pools may be specific to a different model.
  const pool = event.metered_limit_name ?? event.limit_name;
  if (pool !== undefined && pool !== "codex") return {};
  const limits = record(event.rate_limits);
  const windows: Record<string, QuotaWindow> = {};
  for (const key of ["primary", "secondary"]) {
    const w = record(limits[key]);
    const window = passiveWindow(passiveNumber(w.used_percent),
      Object.hasOwn(w, "window_minutes") ? passiveNumber(w.window_minutes) * 60 : undefined,
      Object.hasOwn(w, "reset_at") ? passiveNumber(w.reset_at) : undefined, cached[key]);
    if (window) windows[key] = window;
  }
  return windows;
}

/** Owns quota requests and timers for the currently displayed footer. */
export class UsageLimits {
  private provider: string | null = null;
  private selection: string | null = null;
  private ctx: ExtensionContext | null = null;
  private windows: Record<string, QuotaWindow> = {};
  private updatedAt: Record<string, number> = {};
  private stale = false;
  private attemptedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private request: AbortController | null = null;

  constructor(private readonly render: () => void) {}

  stop(): void {
    this.ctx = null;
    this.provider = null;
    this.selection = null;
    this.windows = {};
    this.updatedAt = {};
    this.stale = false;
    this.attemptedAt = 0;
    this.cancelRequest();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  select(ctx: ExtensionContext, enabled: boolean): void {
    const model = ctx.model;
    if (!enabled || ctx.mode !== "tui" || !model || !supportedOrigin(model.provider, model.baseUrl)) {
      this.stop();
      return;
    }
    const selection = model.provider + (model.provider === "google-gemini-cli" ? ":" + model.id : "");
    if (this.selection === selection) { this.ctx = ctx; return; }
    this.stop();
    this.ctx = ctx;
    this.provider = model.provider;
    this.selection = selection;
    void this.poll();
  }

  headers(provider: string, headers: Record<string, string>): void {
    if (provider !== this.provider) return;
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    this.accept(fromHeaders(provider, lower, this.windows));
  }

  stream(provider: string, model: string, data: unknown): void {
    if (provider !== "openai-codex" || provider !== this.provider || model !== this.ctx?.model?.id) return;
    this.accept(fromStream(data, this.windows));
  }

  private cancelRequest(): void {
    this.request?.abort();
    this.request = null;
  }

  private selectedWindow(): [string, QuotaWindow] | null {
    const window = shortest(Object.values(this.windows));
    return window ? Object.entries(this.windows).find(([, value]) => value === window)! : null;
  }

  private accept(windows: Record<string, QuotaWindow>): void {
    if (!this.ctx || !Object.keys(windows).length) return;
    Object.assign(this.windows, windows);
    for (const key of Object.keys(windows)) this.updatedAt[key] = Date.now();
    const selected = this.selectedWindow()!;
    if (Object.hasOwn(windows, selected[0])) {
      // Only a response for the displayed window supersedes its background refresh.
      this.cancelRequest();
      this.stale = false;
    }
    this.schedule();
    this.render();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.ctx || this.request) return;
    const selected = this.selectedWindow();
    let next = Math.max(this.attemptedAt, selected ? this.updatedAt[selected[0]] : 0) + REFRESH_MS;
    const resetAt = selected?.[1].resetAt;
    if (resetAt != null && resetAt > this.attemptedAt) next = Math.min(next, resetAt);
    this.timer = setTimeout(() => { this.timer = null; void this.poll(); }, Math.max(1, next - Date.now()));
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    const ctx = this.ctx;
    const model = ctx?.model;
    if (!ctx || !model || this.request) return;
    const provider = this.provider!;
    const modelId = model.id;
    const controller = new AbortController();
    this.request = controller;
    this.attemptedAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), 5000);
    timeout.unref();
    try {
      const request = await abortable(usageRequest(ctx, model), controller.signal);
      if (this.request !== controller) return;
      if (controller.signal.aborted) throw new Error("Usage authentication timed out");
      if (!request) { this.windows = {}; this.updatedAt = {}; return; }
      const response = await abortable(fetch(request.url, { ...request.init, signal: controller.signal, redirect: "error" }), controller.signal);
      if (!response.ok) { await abortable(Promise.resolve(response.body?.cancel()), controller.signal); throw new Error("Usage unavailable"); }
      const windows = parseUsageWindows(provider, modelId, await abortable(response.json(), controller.signal));
      if (this.request !== controller) return;
      if (controller.signal.aborted) throw new Error("Usage request timed out");
      this.windows = windows ?? {};
      this.updatedAt = Object.fromEntries(Object.keys(this.windows).map((key) => [key, this.attemptedAt]));
      this.stale = false;
    } catch {
      if (this.request === controller) this.stale = true;
    } finally {
      clearTimeout(timeout);
      if (this.request === controller) {
        this.request = null;
        this.schedule();
        this.render();
      }
    }
  }

  line(width: number, theme: Theme, maxCells = 10): string | null {
    const window = this.selectedWindow()?.[1];
    if (!this.ctx || !window) return null;
    const now = Date.now();
    const date = window.resetAt === null ? null : new Date(window.resetAt);
    const remaining = window.resetAt === null ? 0 : window.resetAt - now;
    const day = 24 * 60 * 60 * 1000;
    let time = date ? `↻${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : "";
    if (remaining > 10 * day) {
      time = `↻${Math.floor(remaining / day)}d`;
    } else if (remaining > day) {
      time = `↻${Math.floor(remaining / day)}d${Math.floor(remaining % day / (60 * 60 * 1000))}h`;
    }
    if (width < (time ? time.length : 1)) return null;
    const cells = Math.min(maxCells, Math.max(0, width - time.length));
    const steps = Math.round(window.used / 100 * cells * 8);
    const filled = "⣿".repeat(Math.floor(steps / 8)) + ["", "⡀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷"][steps % 8];
    const empty = "⠀".repeat(cells - Math.ceil(steps / 8));
    const stale = this.stale || (window.resetAt !== null && now >= window.resetAt);
    const color = stale ? "dim" : window.used >= 92 ? "error" : window.used >= 85 ? "warning" : "success";
    const bar = cells ? theme.fg(color, filled) + theme.fg("dim", empty) : "";
    return bar + theme.fg("dim", time);
  }
}
