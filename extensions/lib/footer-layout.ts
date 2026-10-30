import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BASE_BAR_CELLS } from "./usage-limits.js";

// Keep bar/reset together; shorten location/statuses before model/context.
// Measurements include ANSI styling and wide characters.
const MODEL_GAP = " · ";
const USAGE_GAP = " · ";
const LOCATION_GAP_WIDTH = 3;
// Below these budgets, ellipses dominate text and status tabs stop being useful at a glance.
const MIN_TEXT_WIDTH = 4;
const MIN_STATUS_WIDTH = 12;

export interface LineParts {
  width: number;
  path: string;
  statuses: string;
  branch: string;
  model: string;
  context: string;
  usage: (available: number, maxCells?: number) => string | null;
  statusSeparator: string;
  locationSeparator: string;
  maxUsageBarCells: number;
  borderColor?: ((text: string) => string) | undefined;
}

export function buildLine({
  width, path, statuses, branch, model, context, usage,
  statusSeparator, locationSeparator, maxUsageBarCells, borderColor,
}: LineParts): string {
  if (width <= 0) return "";
  const edgeWidth = borderColor ? 4 : 2;
  if (width <= edgeWidth) return borderColor ? borderColor("─".repeat(width)) : " ".repeat(width);
  width -= edgeWidth;
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
  const gapWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
  if (!borderColor) return " " + left + " ".repeat(gapWidth) + right + " ";
  if (!left && !right) return borderColor("─".repeat(width + edgeWidth));
  // Only structural padding becomes a rule; spaces inside supplied text remain untouched.
  const beforeRule = left && gapWidth ? " " : "";
  const afterRule = right && gapWidth > beforeRule.length ? " " : "";
  const rule = borderColor("─".repeat(Math.max(0, gapWidth - beforeRule.length - afterRule.length)));
  return borderColor("─") + " " + left + beforeRule + rule + afterRule + right + " " + borderColor("─");
}
