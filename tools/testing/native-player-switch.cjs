const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const {
    stageKSPlayerMetalMainBundleResources
} = require('../packaging/ksplayer-metal-packaging.cjs');

// Exercise the real audio-driver failure/fallback and engine disposal boundary.
// Supply a local video with mono AAC audio to reproduce the macOS 27 failure.
const mediaPath = process.argv[2];
assert.ok(mediaPath && fs.existsSync(mediaPath), 'Pass a local media fixture');
const cycles = Number(process.argv[3] ?? 5);
assert.ok(Number.isInteger(cycles) && cycles > 0, 'Cycles must be positive');
const nativeRoot = path.resolve(
    __dirname,
    '../../apps/electron-backend/native/build/Release'
);
const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), 'arm-nator-native-switch-')
);
app.setPath('userData', profile);
stageKSPlayerMetalMainBundleResources(
    process.resourcesPath,
    path.resolve(process.execPath, '..', '..', '..'),
    nativeRoot
);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function awaitPlayback(readSnapshot, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const snapshot = readSnapshot();
        if (snapshot.status === 'error')
            throw new Error(`${label}: ${snapshot.error}`);
        if (snapshot.positionSeconds > 0.5) {
            console.log(
                `${label}: playback advanced to ${snapshot.positionSeconds.toFixed(2)}s`
            );
            return;
        }
        await pause(100);
    }
    throw new Error(`${label}: playback did not advance`);
}

app.whenReady()
    .then(async () => {
        const mpv = require(path.join(nativeRoot, 'embedded_mpv.node'));
        const ks = require(path.join(nativeRoot, 'ksplayer_metal.node'));
        assert.equal(
            ks.getSupport().supported,
            true,
            'KSPlayer runtime available'
        );
        const window = new BrowserWindow({
            width: 640,
            height: 400,
            show: false
        });
        await window.loadURL(
            'data:text/html,<title>Native engine regression</title>'
        );
        const bounds = { x: 0, y: 0, width: 640, height: 360 };
        const streamUrl = pathToFileURL(path.resolve(mediaPath)).href;
        try {
            for (let cycle = 1; cycle <= cycles; cycle++) {
                const mpvId = mpv.createSession(
                    window.getNativeWindowHandle(),
                    bounds,
                    'Regression',
                    0
                );
                try {
                    mpv.loadPlayback(mpvId, { streamUrl, isLive: false });
                    await awaitPlayback(
                        () => mpv.getSessionSnapshot(mpvId),
                        `MPV cycle ${cycle}`
                    );
                    assert.equal(
                        mpv.getSessionSnapshot(mpvId).streamUrl,
                        path.resolve(mediaPath),
                        'MPV string events preserve the source URL'
                    );
                } finally {
                    mpv.disposeSession(mpvId);
                }
                const ksId = `switch-regression-${cycle}`;
                assert.notEqual(
                    ks.createSession(
                        ksId,
                        window.getNativeWindowHandle(),
                        bounds
                    ).ok,
                    false
                );
                try {
                    assert.notEqual(ks.load(ksId, streamUrl, {}).ok, false);
                    await awaitPlayback(
                        () => ks.getSnapshot(ksId),
                        `KSPlayer cycle ${cycle}`
                    );
                    ks.setPaused(ksId, true);
                    const before = ks.getSnapshot(ksId).positionSeconds;
                    await pause(300);
                    assert.ok(
                        Math.abs(
                            ks.getSnapshot(ksId).positionSeconds - before
                        ) < 0.15,
                        'Pause stops playback'
                    );
                } finally {
                    assert.notEqual(ks.disposeSession(ksId).ok, false);
                }
            }
            await pause(1000);
            console.log(
                `PASS: ${cycles} MPV → KSPlayer switches without a native crash`
            );
            window.destroy();
            app.exit(0);
        } catch (error) {
            console.error(error);
            app.exit(1);
        }
    })
    .catch((error) => {
        console.error(error);
        app.exit(1);
    });

app.on('quit', () => fs.rmSync(profile, { recursive: true, force: true }));
