import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredentialTestResultsCsv } from './credential-export';
import type { BulkTestResult } from './bulk-tester.models';

const results: BulkTestResult[] = [
    {
        id: 'xtream-1',
        candidate: {
            id: 'xtream-1',
            type: 'xtream',
            originalText: 'https://provider.test secret-user secret-password',
            serverUrl: 'https://provider.test',
            username: 'secret-user',
            password: 'secret-password',
            normalizedKey: 'internal-only',
        },
        status: 'expired',
        message: 'Not exported.',
        selected: false,
        accountStatus: 'Expired, "checked"',
    },
];

test('exports Xtream source URLs and credential fields without redaction', () => {
    const csv = createCredentialTestResultsCsv(results);

    assert.match(csv, /^id,type,source,username,password,status,/);
    assert.match(csv, /secret-user,secret-password/);
    assert.match(csv, /"Expired, ""checked"""/);
    assert.doesNotMatch(csv, /intentionally not an exported column/);
    assert.doesNotMatch(csv, /originalText/);
});
