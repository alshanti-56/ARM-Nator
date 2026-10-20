import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getRequiredMpvPatches,
    hasRequiredMpvPatches
} from './runtime-patches.mjs';
import * as runtimePatches from './runtime-patches.mjs';

test('rejects an old bundled runtime without the CoreAudio fix', () => {
    assert.equal(hasRequiredMpvPatches({ mpv: { version: '0.41.0' } }), false);
});

test('accepts a runtime built with every required patch', () => {
    assert.equal(
        hasRequiredMpvPatches({ mpv: { patches: getRequiredMpvPatches() } }),
        true
    );
});

test('rejects a stale patch revision so a changed patch triggers rebuilding', () => {
    const patches = getRequiredMpvPatches().map((patch) => ({
        ...patch,
        sha256: 'stale'
    }));
    assert.equal(hasRequiredMpvPatches({ mpv: { patches } }), false);
});

test('rejects a runtime with callback cleanup but without the disposal fix', () => {
    assert.equal(
        hasRequiredMpvPatches({
            mpv: { patches: getRequiredMpvPatches().slice(0, 1) }
        }),
        false
    );
});

test('rejects malformed runtime patch metadata', () => {
    for (const manifest of [
        null,
        {},
        { mpv: { patches: {} } },
        { mpv: { patches: [null] } }
    ]) {
        assert.equal(hasRequiredMpvPatches(manifest), false);
    }
});

test('rejects a bundled runtime without the subtitle-position fix', () => {
    assert.equal(
        runtimePatches.hasRequiredLibassPatches?.({
            packages: { libass: { version: '0.17.3' } }
        }),
        false
    );
});

test('accepts a runtime built with the required libass patch', () => {
    const patches = runtimePatches.getRequiredLibassPatches?.();
    assert.ok(Array.isArray(patches));
    assert.equal(
        runtimePatches.hasRequiredLibassPatches?.({
            packages: { libass: { patches } }
        }),
        true
    );
});

test('rejects a stale libass patch hash so the runtime is rebuilt', () => {
    const patches = (runtimePatches.getRequiredLibassPatches?.() ?? []).map(
        (patch) => ({ ...patch, sha256: 'stale' })
    );
    assert.equal(
        runtimePatches.hasRequiredLibassPatches?.({
            packages: { libass: { patches } }
        }),
        false
    );
});

test('rejects malformed libass patch metadata', () => {
    for (const manifest of [
        null,
        {},
        { packages: { libass: { patches: {} } } },
        { packages: { libass: { patches: [null] } } }
    ]) {
        assert.equal(runtimePatches.hasRequiredLibassPatches(manifest), false);
    }
});
