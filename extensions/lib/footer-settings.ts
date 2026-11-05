import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { MAX_BAR_CELLS } from "./usage-limits.js";

interface Settings {
  minFooter?: {
    enabled?: boolean;
    compactEditor?: boolean;
    showGitBranch?: boolean;
    showSkills?: boolean;
    showPath?: boolean;
    showModel?: boolean;
    showContext?: boolean;
    showProvider?: boolean;
    showThinking?: boolean;
    showUsage?: boolean;
    showCost?: boolean;
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
  compactEditor: false,
  showGitBranch: true,
  showSkills: true,
  showPath: true,
  showModel: true,
  showContext: true,
  showProvider: false,
  showThinking: false,
  showUsage: true,
  showCost: true,
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

function readSettings(): Settings | null {
  try {
    const settings: unknown = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    // Valid JSON can still be null or a scalar; a broken preference file must not prevent loading.
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return null;
    return settings as Settings;
  } catch (error) {
    // Only a missing file is safe to create; unreadable or invalid files must survive toggles.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

function isTimerSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TIMER_SECONDS;
}

function configFrom(settings: Settings): FooterSettings {
  const preferences = settings.minFooter;
  const config = {
    ...DEFAULT_SETTINGS,
    ...(preferences !== null && typeof preferences === "object" && !Array.isArray(preferences) ? preferences : {}),
  };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]) {
    const fallback = DEFAULT_SETTINGS[key];
    if (typeof fallback === "boolean" && typeof config[key] !== "boolean") {
      Object.assign(config, { [key]: fallback });
    }
  }
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

export function readConfig(): FooterSettings {
  return configFrom(readSettings() ?? {});
}

export function writeEnabled(v: boolean): void {
  const current = readSettings();
  if (current === null) return;
  const cfg = configFrom(current);
  cfg.enabled = v;
  try {
    const path = settingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...current, minFooter: cfg }, null, 2) + "\n");
  } catch {
    // A read-only settings file must not crash the extension.
  }
}
