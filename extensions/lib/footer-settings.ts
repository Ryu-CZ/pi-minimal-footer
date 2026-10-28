import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { MAX_BAR_CELLS } from "./usage-limits.js";

interface Settings {
  minFooter?: {
    enabled?: boolean;
    showGitBranch?: boolean;
    showSkills?: boolean;
    showPath?: boolean;
    showModel?: boolean;
    showContext?: boolean;
    contextAsPercentage?: boolean;
    powerlineSeparator?: boolean;
    gitRefreshSeconds?: number;
    gitFetch?: boolean;
    gitFetchTimeoutSeconds?: number;
    maxUsageBarCells?: number;
  };
}

export type FooterSettings = NonNullable<Settings["minFooter"]>;

// Node clamps timer delays above this signed 32-bit millisecond limit to 1ms.
const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000);

const DEFAULT_SETTINGS: FooterSettings = {
  enabled: true,
  showGitBranch: true,
  showSkills: true,
  showPath: true,
  showModel: true,
  showContext: true,
  contextAsPercentage: false,
  powerlineSeparator: true,
  gitRefreshSeconds: 91,
  gitFetch: false,
  gitFetchTimeoutSeconds: 17,
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

export function readConfig(): FooterSettings {
  const s = readSettings();
  const config = { ...DEFAULT_SETTINGS, ...s.minFooter };
  if (typeof config.gitRefreshSeconds !== "number" || !Number.isSafeInteger(config.gitRefreshSeconds) || config.gitRefreshSeconds < 1 || config.gitRefreshSeconds > MAX_TIMER_SECONDS) {
    config.gitRefreshSeconds = 91;
  }
  if (typeof config.gitFetchTimeoutSeconds !== "number" || !Number.isSafeInteger(config.gitFetchTimeoutSeconds) || config.gitFetchTimeoutSeconds < 1 || config.gitFetchTimeoutSeconds > MAX_TIMER_SECONDS) {
    config.gitFetchTimeoutSeconds = 17;
  }
  if (typeof config.maxUsageBarCells !== "number" || !Number.isSafeInteger(config.maxUsageBarCells) || config.maxUsageBarCells < 1) {
    config.maxUsageBarCells = MAX_BAR_CELLS;
  }
  return config;
}

export function writeEnabled(v: boolean): void {
  const cfg = readConfig();
  cfg.enabled = v;
  writeSettings({ minFooter: cfg });
}
