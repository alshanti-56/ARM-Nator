import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredentialTestResultsCsv } from './credential-export';
import type { BulkTestResult } from './bulk-tester.models';

const results: BulkTestResult[] = [
    {
        id: 'm3u-1',
        candidate: {
            id: 'm3u-1',
            type: 'm3u',
            originalText:
                'https://user:password@provider.test/list.m3u?user=alice&pwd=hunter2&token=dropme&quality=hd&name=a,b',
            serverUrl: '',
            playlistUrl:
                'https://user:password@provider.test/list.m3u?user=alice&pwd=hunter2&token=dropme&quality=hd&name=a,b',
            username: '',
            password: '',
            normalizedKey: 'internal-only',
        },
        status: 'working',
        message: 'This is intentionally not an exported column.',
        selected: true,
        responseTimeMs: 42,
    },
    {
        id: 'xtream-1',
        candidate: {
            id: 'xtream-1',
            type: 'xtream',
            originalText: 'https://provider.test secret-user secret-password',
            serverUrl: 'https://provider.test',
            playlistUrl: '',
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

test('exports supplied source URLs and credential fields without redaction', () => {
    const csv = createCredentialTestResultsCsv(results);

    assert.match(csv, /^id,type,source,username,password,status,/);
    assert.match(
        csv,
        /https:\/\/user:password@provider\.test\/list\.m3u\?user=alice&pwd=hunter2&token=dropme&quality=hd&name=a,b/
    );
    assert.match(csv, /secret-user,secret-password/);
    assert.match(csv, /"Expired, ""checked"""/);
    assert.match(csv, /alice/);
    assert.match(csv, /hunter2/);
    assert.match(csv, /dropme/);
    assert.doesNotMatch(csv, /intentionally not an exported column/);
    assert.doesNotMatch(csv, /originalText/);
});
