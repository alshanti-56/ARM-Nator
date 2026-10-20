import assert from 'node:assert/strict';
import test from 'node:test';
import { createValidatedStalkerPlaylist } from './stalker-playlist-save';

test('saves the resolved API endpoint and its session metadata instead of the pasted client URL', () => {
    const playlist = createValidatedStalkerPlaylist({
        id: 'test', status: 'working', message: 'Validated', selected: true,
        candidate: { id: 'test', type: 'stalker', originalText: '', portalUrl: 'https://portal.test/c', macAddress: '00:1A:79:AA:BB:CC', normalizedKey: '' },
        resolvedPortalUrl: 'https://portal.test/server/load.php',
        isFullStalkerPortal: true, stalkerToken: 'test-token',
        watchdogTimeoutSeconds: 30, timeslotSeconds: 10,
    });
    assert.equal(playlist.portalUrl, 'https://portal.test/server/load.php');
    assert.equal(playlist.macAddress, '00:1A:79:AA:BB:CC');
    assert.equal(playlist.isFullStalkerPortal, true);
    assert.equal(playlist.stalkerToken, 'test-token');
    assert.equal(playlist.stalkerWatchdogTimeout, 30);
});
