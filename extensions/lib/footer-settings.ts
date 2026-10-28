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

const DEFAULT_SETTINGS = {
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
} satisfies FooterSettings;

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

function isTimerSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMER_SECONDS;
}

export function readConfig(): FooterSettings {
  const settings = readSettings();
  const config = { ...DEFAULT_SETTINGS, ...settings.minFooter };
  if (!isTimerSeconds(config.gitRefreshSeconds)) {
    config.gitRefreshSeconds = DEFAULT_SETTINGS.gitRefreshSeconds;
  }
  if (!isTimerSeconds(config.gitFetchTimeoutSeconds)) {
    config.gitFetchTimeoutSeconds = DEFAULT_SETTINGS.gitFetchTimeoutSeconds;
  }
  if (!Number.isSafeInteger(config.maxUsageBarCells) || config.maxUsageBarCells < 1) {
    config.maxUsageBarCells = DEFAULT_SETTINGS.maxUsageBarCells;
  }
  return config;
}

export function writeEnabled(v: boolean): void {
  const cfg = readConfig();
  cfg.enabled = v;
  writeSettings({ minFooter: cfg });
}
