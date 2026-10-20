import assert from 'node:assert/strict';
import test from 'node:test';
import { queryAutomaticNativeSupport } from './automatic-native-support';

test('a hanging optional native backend cannot prevent another available engine from being used', async () => {
    const support = await queryAutomaticNativeSupport({
        embeddedMpv: () => new Promise(() => undefined),
        ksPlayer: async () => ({ supported: true }),
    }, 10);
    assert.deepEqual(support, { embeddedMpv: false, ksPlayer: true });
});

test('missing and rejected native probes leave browser playback available', async () => {
    assert.deepEqual(await queryAutomaticNativeSupport({ ksPlayer: () => Promise.reject(new Error('Addon unavailable')) }),
        { embeddedMpv: false, ksPlayer: false });
});
