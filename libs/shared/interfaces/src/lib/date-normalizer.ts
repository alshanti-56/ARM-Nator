const SQLITE_UTC_TIMESTAMP_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

/** Normalize epoch, numeric, SQLite, or ISO values into ISO 8601. */
export function normalizeDate(value: unknown): string {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '';
        const ms = value > 10_000_000_000 ? value : value * 1000;
        return new Date(ms).toISOString();
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\d+$/.test(trimmed)) {
            const numeric = Number(trimmed);
            if (Number.isFinite(numeric)) {
                const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
                return new Date(ms).toISOString();
            }
        }
        const sqliteUtcIso = normalizeSqliteUtcTimestamp(trimmed);
        if (sqliteUtcIso) return sqliteUtcIso;
        const parsed = Date.parse(trimmed);
        if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }

    return '';
}

function normalizeSqliteUtcTimestamp(value: string): string | null {
    const match = SQLITE_UTC_TIMESTAMP_PATTERN.exec(value);
    if (!match) return null;

    const [, year, month, day, hours, minutes, seconds, milliseconds = '0'] =
        match;
    const normalizedMs = milliseconds.padEnd(3, '0').slice(0, 3);
    return new Date(
        Date.UTC(
            Number(year), Number(month) - 1, Number(day), Number(hours),
            Number(minutes), Number(seconds), Number(normalizedMs)
        )
    ).toISOString();
}
