import { addDays, format, subDays } from 'date-fns';

export const EPG_DATE_KEY_FORMAT = 'yyyy-MM-dd';

export type EpgDateNavigationDirection = 'next' | 'prev';

export function getTodayEpgDateKey(): string {
    return format(new Date(), EPG_DATE_KEY_FORMAT);
}

export function parseEpgDateKey(
    dateKey: string | null | undefined,
    fallbackDateKey = getTodayEpgDateKey()
): Date {
    const normalizedDateKey =
        typeof dateKey === 'string' && dateKey.trim().length > 0
            ? dateKey
            : fallbackDateKey;
    const parsedDate = new Date(`${normalizedDateKey}T00:00:00`);

    if (Number.isFinite(parsedDate.getTime())) {
        return parsedDate;
    }

    return new Date(`${fallbackDateKey}T00:00:00`);
}

export function shiftEpgDateKey(
    dateKey: string | null | undefined,
    direction: EpgDateNavigationDirection
): string {
    const selectedDate = parseEpgDateKey(dateKey);
    return format(
        direction === 'next'
            ? addDays(selectedDate, 1)
            : subDays(selectedDate, 1),
        EPG_DATE_KEY_FORMAT
    );
}
