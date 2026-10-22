/** Opaque catalogue position only; never contains a transport URL or credentials. */
export interface SourceSampleCursor {
  group: string;
  page: number;
  item: string;
}
export function readSourceSampleCursor(
  value?: string,
): SourceSampleCursor | null {
  if (!value) return null;
  try {
    const v: unknown = JSON.parse(value);
    if (
      Array.isArray(v) &&
      v.length === 3 &&
      typeof v[0] === "string" &&
      Number.isSafeInteger(v[1]) &&
      v[1] >= 1 &&
      typeof v[2] === "string"
    )
      return { group: v[0], page: v[1], item: v[2] };
  } catch {
    /* Cached Xtream positions use category:item. */
  }
  const colon = value.indexOf(":");
  return colon >= 0
    ? { group: value.slice(0, colon), page: 1, item: value.slice(colon + 1) }
    : { group: "", page: 1, item: value };
}
export function sourceSampleCursor(
  group: string,
  page: number,
  item: string,
): string {
  return JSON.stringify([group, page, item]);
}
export function rotateSourceRows<T>(
  rows: readonly T[],
  id: (row: T) => string,
  item: string | undefined,
  include = false,
): T[] {
  const index = item === undefined ? -1 : rows.findIndex((r) => id(r) === item);
  const start = index < 0 ? 0 : index + (include ? 0 : 1);
  return [...rows.slice(start), ...rows.slice(0, start)];
}
