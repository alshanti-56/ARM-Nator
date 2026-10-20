import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Compile the actual patched MPV function bodies against counted AudioUnit
// calls. Each initialization failure is injected without touching real audio.
const source = fs.readFileSync(
    path.join(process.argv[2], 'audio/out/ao_coreaudio.c'),
    'utf8'
);
function functionBody(name) {
    const start = source.indexOf(`static ${name}`);
    assert.ok(start >= 0, `Missing definition: ${name}`);
    const open = source.indexOf('{', start);
    let depth = 1;
    let end = open + 1;
    for (; depth && end < source.length; end++) {
        if (source[end] === '{') depth++;
        if (source[end] === '}') depth--;
    }
    assert.equal(depth, 0, `Unbalanced function: ${name}`);
    return source.slice(start, end);
}

const audioInit = functionBody(
    'bool init_audiounit(struct ao *ao, AudioStreamBasicDescription asbd, AudioChannelLayout *layout, size_t layout_size)\n{'
);
const audioUninit = functionBody('void uninit(struct ao *ao)\n{');
const harness = `
#include <AudioToolbox/AudioToolbox.h>
#include <dispatch/dispatch.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
struct priv {
    AudioUnit audio_unit;
    AudioDeviceID device;
    dispatch_queue_t queue;
    AudioStreamBasicDescription original_asbd;
    AudioStreamID original_asbd_stream;
};
struct ao { struct priv *priv; char *device; };
static int failure, property_calls, disposals, uninitializes, stops, hotplug_removals;
static AudioComponent find_component(AudioComponent c, const AudioComponentDescription *d) {
    return failure == -2 ? NULL : (AudioComponent)1;
}
static OSStatus new_component(AudioComponent c, AudioComponentInstance *unit) {
    if (failure == -1) return -50;
    *unit = (AudioComponentInstance)1;
    return noErr;
}
static OSStatus initialize_unit(AudioUnit unit) { return failure == 0 ? -50 : noErr; }
static OSStatus set_property(AudioUnit unit, AudioUnitPropertyID id, AudioUnitScope scope, AudioUnitElement element, const void *data, UInt32 size) {
    return ++property_calls == failure ? -50 : noErr;
}
static OSStatus uninitialize_unit(AudioUnit unit) { uninitializes++; return noErr; }
static OSStatus dispose_component(AudioComponentInstance unit) { disposals++; return noErr; }
static OSStatus stop_unit(AudioUnit unit) { stops++; return noErr; }
static OSStatus render_cb_lpcm(void *ctx, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *time, UInt32 bus, UInt32 frames, AudioBufferList *data) { return noErr; }
static void cancel_and_release_idle_work(struct priv *p) {}
static void unregister_hotplug_cb(struct ao *ao) { hotplug_removals++; }
#define MP_ERR(...) ((void)0)
#define CHECK_CA_ERROR(msg) do { if (err != noErr) goto coreaudio_error; } while (0)
#define CHECK_CA_ERROR_L(label, msg) do { if (err != noErr) goto label; } while (0)
#define CHECK_CA_WARN(msg) ((void)0)
#define CA_SET(...) noErr
#define AudioComponentFindNext find_component
#define AudioComponentInstanceNew new_component
#define AudioUnitInitialize initialize_unit
#define AudioUnitSetProperty set_property
#define AudioUnitUninitialize uninitialize_unit
#define AudioComponentInstanceDispose dispose_component
#define AudioOutputUnitStop stop_unit
${audioInit}
${audioUninit}
int main(void) {
    int failed = 0;
    for (failure = -2; failure <= 5; failure++) {
        struct priv p = {0};
        struct ao ao = { .priv = &p };
        property_calls = disposals = uninitializes = stops = hotplug_removals = 0;
        bool initialized = init_audiounit(&ao, (AudioStreamBasicDescription){0}, NULL, 0);
        // init() calls uninit() when init_audiounit() returns false; on a
        // successful initialization the driver calls it during shutdown.
        uninit(&ao);
        int expected_disposals = failure < 0 ? 0 : 1;
        int expected_uninitializes = failure > 0 ? 1 : 0;
        int expected_stops = initialized ? 1 : 0;
        if (disposals != expected_disposals || uninitializes != expected_uninitializes || stops != expected_stops || hotplug_removals != 1) {
            fprintf(stderr, "FAIL stage %d: disposals=%d (expected %d), uninitializes=%d (expected %d), stops=%d (expected %d)\\n", failure, disposals, expected_disposals, uninitializes, expected_uninitializes, stops, expected_stops);
            failed = 1;
            continue;
        }
        printf("PASS stage %d: disposals=%d, uninitializes=%d, stops=%d\\n", failure, disposals, uninitializes, stops);
    }
    return failed;
}
`;

const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'arm-nator-coreaudio-cleanup-')
);
try {
    const file = path.join(temporary, 'cleanup.c');
    const executable = path.join(temporary, 'cleanup');
    fs.writeFileSync(file, harness);
    const compile = spawnSync('clang', ['-fblocks', file, '-o', executable], {
        encoding: 'utf8'
    });
    assert.equal(compile.status, 0, compile.stderr || String(compile.error));
    const result = spawnSync(executable, [], { encoding: 'utf8' });
    process.stdout.write(result.stdout);
    assert.equal(result.status, 0, result.stderr || String(result.error));
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
