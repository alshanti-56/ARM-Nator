import type { BulkTestResult } from './bulk-tester.models';

export const CREDENTIAL_TEST_EXPORT_COLUMNS = [
    'id',
    'type',
    'source',
    'username',
    'password',
    'status',
    'responseTimeMs',
    'httpStatus',
    'accountStatus',
    'expiresAt',
    'activeConnections',
    'maxConnections',
    'liveCategoriesCount',
    'moviesCount',
    'seriesCount',
    'playlistChannelCount',
    'lastCheckedAt',
] as const;

type CredentialTestExportColumn =
    (typeof CREDENTIAL_TEST_EXPORT_COLUMNS)[number];

function csvCell(value: string | number | undefined): string {
    const text = value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sourceUrl(result: BulkTestResult): string {
    return result.candidate.serverUrl;
}

function rowValue(
    result: BulkTestResult,
    column: CredentialTestExportColumn
): string | number | undefined {
    switch (column) {
        case 'id':
            return result.id;
        case 'type':
            return result.candidate.type;
        case 'source':
            return sourceUrl(result);
        case 'username':
            return result.candidate.username;
        case 'password':
            return result.candidate.password;
        case 'status':
            return result.status;
        case 'responseTimeMs':
            return result.responseTimeMs;
        case 'httpStatus':
            return result.httpStatus;
        case 'accountStatus':
            return result.accountStatus;
        case 'expiresAt':
            return result.expiresAt;
        case 'activeConnections':
            return result.activeConnections;
        case 'maxConnections':
            return result.maxConnections;
        case 'liveCategoriesCount':
            return result.liveCategoriesCount;
        case 'moviesCount':
            return result.moviesCount;
        case 'seriesCount':
            return result.seriesCount;
        case 'playlistChannelCount':
            return result.playlistChannelCount;
        case 'lastCheckedAt':
            return result.lastCheckedAt;
    }
}

/** Exports the explicit bulk-test result columns, including supplied credentials. */
export function createCredentialTestResultsCsv(
    results: readonly BulkTestResult[]
): string {
    const rows = results.map((result) =>
        CREDENTIAL_TEST_EXPORT_COLUMNS.map((column) =>
            csvCell(rowValue(result, column))
        ).join(',')
    );

    return [CREDENTIAL_TEST_EXPORT_COLUMNS.join(','), ...rows].join('\r\n');
}
