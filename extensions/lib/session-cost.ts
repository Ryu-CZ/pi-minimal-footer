import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Match Pi's session total, but only expose it for a priced, non-subscription model. */
export function sessionCost(ctx: ExtensionContext): string | null {
  const model = ctx.model;
  if (!model || model.provider === "kimi-coding" || model.provider === "opencode-go") return null;
  const registry = ctx.modelRegistry;
  if (registry?.isUsingOAuth?.(model) &&
      registry.getProvider?.(model.provider)?.auth.oauth?.isSubscription !== false) return null;
  const rates = model.cost;
  if (!rates || ![rates, ...(rates.tiers ?? [])].some((rate) =>
    [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].some((price) => Number.isFinite(price) && price > 0))) return null;

  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    const usage = entry.type === "message"
      ? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
      : (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined);
    const cost = usage?.cost.total;
    if (cost !== undefined && Number.isFinite(cost) && cost >= 0) total += cost;
  }
  return `~$${total.toFixed(3)}`;
}
