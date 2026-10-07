// Provider endpoint and parsing logic copied and adapted from:
// https://pi.dev/packages/@ogulcancelik/pi-minimal-footer
// Copyright (c) 2025 Can Celik. MIT license: ./LICENSE.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface UsageWindow {
  used: number;
  seconds: number | null;
  resetAt: number | null;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function resetSeconds(value: unknown): number | undefined {
  const n = typeof value === "string" && !Number.isFinite(Number(value)) ? Date.parse(value) / 1000 : number(value);
  const seconds = n === undefined ? undefined : n > 100_000_000_000 ? n / 1000 : n;
  return seconds !== undefined && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds : undefined;
}

export function windowFrom(used: unknown, seconds: unknown, reset: unknown): UsageWindow | null {
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
  if (seconds != null && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0)) return null;
  const validReset = typeof reset === "number" && reset > 0 && Number.isFinite(new Date(reset * 1000).getTime());
  return { used, seconds: typeof seconds === "number" ? seconds : null, resetAt: validReset ? reset * 1000 : null };
}

export function shortest(windows: (UsageWindow | null)[]): UsageWindow | null {
  return windows.filter((w): w is UsageWindow => w !== null)
    .sort((a, b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity) || b.used - a.used)[0] ?? null;
}

const ENDPOINTS: Record<string, string> = {
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  anthropic: "https://api.anthropic.com/api/oauth/usage",
  "github-copilot": "https://api.github.com/copilot_internal/user",
  "google-gemini-cli": "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
  minimax: "https://api.minimax.io/v1/token_plan/remains",
  "minimax-cn": "https://api.minimaxi.com/v1/token_plan/remains",
  "kimi-coding": "https://api.kimi.com/coding/v1/usages",
  "opencode-go": "https://opencode.ai/zen/go/v1/usage",
};

export function supportedOrigin(provider: string, baseUrl: string | undefined): boolean {
  if (!ENDPOINTS[provider] || !baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    if (provider === "github-copilot") return url.protocol === "https:" && !url.port &&
      (url.hostname === "githubcopilot.com" || url.hostname.endsWith(".githubcopilot.com"));
    return url.origin === new URL(ENDPOINTS[provider]).origin;
  } catch { return false; }
}

function storedOAuth(provider: string): Record<string, unknown> {
  try {
    const entry = record(record(JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8")))[provider]);
    return entry.type === "oauth" ? entry : {};
  } catch { return {}; }
}

export async function usageRequest(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>): Promise<{ url: string; init: RequestInit } | null> {
  const provider = model.provider;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    // Pi exposes missing credentials as a message, alongside transient OAuth errors.
    if (auth.error === `No API key found for "${provider}"`) return null;
    throw new Error(auth.error);
  }
  if (!supportedOrigin(provider, auth.baseUrl ?? model.baseUrl)) return null;
  const authorization = Object.entries(auth.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  let token = typeof authorization === "string" ? /^Bearer\s+(.+)$/i.exec(authorization)?.[1] ?? auth.apiKey : auth.apiKey;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider === "openai-codex") {
    try {
      const payload = record(JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString("utf8")));
      const id = record(payload["https://api.openai.com/auth"]).chatgpt_account_id;
      if (typeof id !== "string" || !id) return null;
      headers["ChatGPT-Account-Id"] = id;
    } catch { return null; }
  } else if (provider === "anthropic") {
    if (!ctx.modelRegistry.isUsingOAuth?.(model) && !token?.startsWith("sk-ant-oat")) return null;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else if (provider === "github-copilot") {
    // Quota API needs the GitHub login token, not the exchanged inference token.
    const refresh = storedOAuth(provider).refresh;
    token = auth.env?.COPILOT_GITHUB_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN ?? (typeof refresh === "string" ? refresh : undefined);
    Object.assign(headers, { "Editor-Version": "vscode/1.96.2", "User-Agent": "GitHubCopilotChat/0.26.7", "X-Github-Api-Version": "2025-04-01" });
  } else if (provider === "google-gemini-cli" && token?.startsWith("{")) {
    const credentials = record(JSON.parse(token));
    token = typeof credentials.token === "string" ? credentials.token : typeof credentials.accessToken === "string" ? credentials.accessToken : undefined;
  }
  if (!token) return null;
  headers.Authorization = `${provider === "github-copilot" ? "token" : "Bearer"} ${token}`;
  const init: RequestInit = { headers };
  if (provider === "google-gemini-cli") {
    init.method = "POST";
    init.body = "{}";
    headers["Content-Type"] = "application/json";
  }
  return { url: ENDPOINTS[provider], init };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function relativeReset(value: unknown): number | undefined {
  const delay = number(value);
  return delay !== undefined && delay >= 0 ? resetSeconds(Date.now() / 1000 + delay) : undefined;
}

export function parseUsageWindows(provider: string, model: string, payload: unknown): Record<string, UsageWindow> | null {
  if (!ENDPOINTS[provider]) return null;
  const windows: Record<string, UsageWindow> = {};
  let recognized = false;
  let malformed = !isObject(payload);
  const data = record(payload);
  const add = (key: string, value: unknown, parse: (w: Record<string, unknown>) => UsageWindow | null) => {
    if (value === undefined) return;
    recognized = true;
    if (value === null) return;
    const window = isObject(value) ? parse(value) : null;
    if (window) windows[key] = window;
    else malformed = true;
  };
  // Valid siblings remain useful; explicit absence clears cache, while malformed
  // snapshots throw so a temporary provider failure retains dimmed cached usage.
  const finish = () => {
    if (Object.keys(windows).length) return windows;
    if (recognized && !malformed) return null;
    throw new Error(`${provider} usage response malformed`);
  };
  if (provider === "openai-codex") {
    if (Object.hasOwn(data, "rate_limit")) {
      recognized = true;
      if (data.rate_limit !== null && !isObject(data.rate_limit)) malformed = true;
      const limits = record(data.rate_limit);
      for (const [key, name] of [["primary", "primary_window"], ["secondary", "secondary_window"]]) {
        add(key, limits[name], (w) => windowFrom(number(w.used_percent),
          Object.hasOwn(w, "limit_window_seconds") ? number(w.limit_window_seconds) ?? NaN : undefined,
          resetSeconds(w.reset_at) ?? relativeReset(w.reset_after_seconds)));
      }
      if (isObject(data.rate_limit) && Object.keys(limits).length &&
          !Object.hasOwn(limits, "primary_window") && !Object.hasOwn(limits, "secondary_window")) malformed = true;
    }
    return finish();
  }
  if (provider === "anthropic") {
    for (const [name, seconds] of [["five_hour", 18000], ["seven_day", 604800]] as const) {
      add(name, data[name], (w) => windowFrom(number(w.utilization), seconds, resetSeconds(w.resets_at)));
    }
    return finish();
  }
  if (provider === "minimax" || provider === "minimax-cn") {
    const status = number(record(data.base_resp).status_code);
    if (status !== undefined && status !== 0) throw new Error("MiniMax usage unavailable");
    if (Object.hasOwn(data, "model_remains")) {
      recognized = true;
      if (data.model_remains !== null && !Array.isArray(data.model_remains)) malformed = true;
    }
    const buckets = Array.isArray(data.model_remains) ? data.model_remains.map(record) : [];
    const w = buckets.find((b) => b.model_name === "general" && number(b.current_interval_status) === 1)
      ?? buckets.find((b) => b.model_name === "general") ?? buckets.find((b) => number(b.current_interval_status) === 1) ?? buckets[0];
    if (w) {
      let supplied = false;
      for (const [key, prefix, startKey, endKey, fallback] of [
        ["interval", "current_interval", "start_time", "end_time", 18000],
        ["weekly", "current_weekly", "weekly_start_time", "weekly_end_time", 604800],
      ] as const) {
        if (!Object.hasOwn(w, `${prefix}_remaining_percent`)) continue;
        supplied = true;
        const remaining = number(w[`${prefix}_remaining_percent`]);
        const start = resetSeconds(w[startKey]), end = resetSeconds(w[endKey]);
        add(key, w, () => windowFrom(remaining === undefined ? undefined : 100 - remaining,
          start !== undefined && end !== undefined ? end - start : fallback, end));
      }
      if (!supplied) malformed = true;
    }
    return finish();
  }
  if (provider === "kimi-coding") {
    const usedPercent = (detail: Record<string, unknown>) => {
      const limit = number(detail.limit);
      const used = Object.hasOwn(detail, "used") ? number(detail.used) : undefined;
      const remaining = number(detail.remaining);
      const count = Object.hasOwn(detail, "used") ? used : limit !== undefined && remaining !== undefined ? limit - remaining : undefined;
      return limit !== undefined && limit > 0 && count !== undefined && count >= 0 && count <= limit ? count / limit * 100 : undefined;
    };
    const units: Record<string, number> = { TIME_UNIT_SECOND: 1, TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86400, TIME_UNIT_WEEK: 604800, TIME_UNIT_MONTH: 2592000 };
    if (Object.hasOwn(data, "limits")) {
      recognized = true;
      if (data.limits !== null && !Array.isArray(data.limits)) malformed = true;
    }
    for (const value of Array.isArray(data.limits) ? data.limits : []) {
      if (!isObject(value)) {
        malformed = true;
        continue;
      }
      const w = record(value), time = record(w.window), detail = record(w.detail);
      const duration = number(time.duration), unit = typeof time.timeUnit === "string" ? time.timeUnit : "";
      const seconds = duration !== undefined && units[unit] ? duration * units[unit] : NaN;
      add(`${duration}:${unit}`, value, () => windowFrom(usedPercent(detail), seconds, resetSeconds(detail.resetTime)));
    }
    add("weekly", data.usage, (w) => windowFrom(usedPercent(w), 604800, resetSeconds(w.resetTime)));
    return finish();
  }
  if (provider === "opencode-go") {
    for (const [name, seconds] of [["rollingUsage", 18000], ["weeklyUsage", 604800], ["monthlyUsage", 2592000]] as const) {
      add(name, data[name], (w) => windowFrom(number(w.usagePercent), seconds, relativeReset(w.resetInSec)));
    }
    return finish();
  }
  if (provider === "github-copilot") {
    if (Object.hasOwn(data, "quota_snapshots")) {
      recognized = true;
      if (data.quota_snapshots !== null && !isObject(data.quota_snapshots)) malformed = true;
    }
    for (const [name, value] of Object.entries(isObject(data.quota_snapshots) ? data.quota_snapshots : {})) {
      if (record(value).unlimited === true) continue;
      add(name, value, (w) => {
        const remaining = number(w.percent_remaining);
        return windowFrom(remaining === undefined ? undefined : 100 - remaining, 2592000, resetSeconds(data.quota_reset_date_utc));
      });
    }
    return finish();
  }
  // Gemini only exposes quotas for the selected model, or a recognizable model family.
  if (Object.hasOwn(data, "buckets")) {
    recognized = true;
    if (data.buckets !== null && !Array.isArray(data.buckets)) malformed = true;
  }
  const buckets = Array.isArray(data.buckets) ? data.buckets.map(record) : [];
  const valid = buckets.filter((b) => {
    const remaining = number(b.remainingFraction);
    const ok = typeof b.modelId === "string" && b.modelId.length > 0 && remaining !== undefined && remaining >= 0 && remaining <= 1;
    if (!ok) malformed = true;
    return ok;
  });
  // A malformed exact match must not substitute another model family's quota.
  const hasExact = buckets.some((b) => b.modelId === model);
  const family = model.toLowerCase().includes("flash") ? "flash" : model.toLowerCase().includes("pro") ? "pro" : null;
  const selected = valid.filter((b) => hasExact ? b.modelId === model : family && String(b.modelId).toLowerCase().includes(family));
  for (const b of selected) {
    const identity = `${b.modelId}:${typeof b.tokenType === "string" ? b.tokenType : ""}`;
    let key = identity, duplicate = 2;
    while (Object.hasOwn(windows, key)) key = `${identity}:${duplicate++}`;
    add(key, b, () => windowFrom((1 - number(b.remainingFraction)!) * 100, undefined, resetSeconds(b.resetTime)));
  }
  return finish();
}

export function parseUsage(provider: string, model: string, payload: unknown): UsageWindow | null {
  return shortest(Object.values(parseUsageWindows(provider, model, payload) ?? {}));
}
