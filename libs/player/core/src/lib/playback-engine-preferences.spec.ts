import { strict as assert } from 'node:assert';
import test from 'node:test';
import { PlaybackEnginePreferences, type PlaybackPreferenceStorage } from './playback-engine-preferences';

class MemoryStorage implements PlaybackPreferenceStorage {
    readonly values = new Map<string, string>();
    getItem(key: string): string | null { return this.values.get(key) ?? null; }
    setItem(key: string, value: string): void { this.values.set(key, value); }
    removeItem(key: string): void { this.values.delete(key); }
}

const scope = (runtime = 'runtime-a') => ({
    sourceIdentity: 'https://user:password@example.test/live?token=secret',
    live: true,
    media: 'hls',
    runtime,
});

test('stores verified successes only and omits raw source credentials from storage keys', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackEnginePreferences(storage, { now: () => 100 });
    assert.equal(preferences.rememberVerifiedSuccess(scope(), 'native', false), false);
    assert.equal(preferences.getCompatible(scope()), null);
    assert.equal(preferences.rememberVerifiedSuccess(scope(), 'native', true), true);
    assert.equal(preferences.getCompatible(scope()), 'native');
    const keys = [...storage.values.keys()].join('\n');
    assert.equal(keys.includes('example.test'), false);
    assert.equal(keys.includes('password'), false);
    assert.equal(keys.includes('secret'), false);
    assert.match(keys, /runtime-a/);
});

test('expires a preference after seven days', () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const preferences = new PlaybackEnginePreferences(storage, { now: () => now });
    preferences.rememberVerifiedSuccess(scope(), 'native', true);
    now += 7 * 24 * 60 * 60 * 1_000 - 1;
    assert.equal(preferences.getCompatible(scope()), 'native');
    now += 1;
    assert.equal(preferences.getCompatible(scope()), null);
});

test('returns only engines accepted by the compatibility check', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackEnginePreferences(storage, { now: () => 10 });
    preferences.rememberVerifiedSuccess(scope(), 'native', true);
    assert.equal(preferences.getCompatible(scope(), (engine) => engine === 'web'), null);
    assert.equal(preferences.getCompatible(scope()), null);
});

test('invalidates on decoder failures but preserves preferences after network failures', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackEnginePreferences(storage, { now: () => 10 });
    preferences.rememberVerifiedSuccess(scope(), 'native', true);
    preferences.invalidateOnFailure(scope(), 'transport');
    assert.equal(preferences.getCompatible(scope()), 'native');
    preferences.invalidateOnFailure(scope(), 'decoder');
    assert.equal(preferences.getCompatible(scope()), null);
});

test('runtime changes invalidate an older engine preference for the same source', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackEnginePreferences(storage, { now: () => 10 });
    preferences.rememberVerifiedSuccess(scope('runtime-a'), 'native', true);
    assert.equal(preferences.getCompatible(scope('runtime-b')), null);
    assert.equal(preferences.getCompatible(scope('runtime-a')), null);
});
