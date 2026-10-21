/** Normalize only the safe delay; transport headers are never persisted. */
export function sourceRetryAfterMs(
  value: unknown,
  now = Date.now(),
): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (!text || text.startsWith("-")) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
