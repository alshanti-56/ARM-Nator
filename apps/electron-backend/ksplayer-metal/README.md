# KSPlayer Metal native runtime

This directory builds the Swift half of ARM-Nator's in-process KSPlayer Metal
backend. It is loaded only by `ksplayer_metal.node` through `dlopen(...,
RTLD_LOCAL)`; it neither links to nor loads `libmpv` or `embedded_mpv.node`.

The staged runtime layout is:

```text
native/
  ksplayer_metal.node
  ksplayer-metal-runtime.json
  ksplayer-metal/
    KSPlayerMetalRuntime.dylib
    Frameworks/*.framework
    KSPlayer_KSPlayer.bundle/Contents/Resources/default.metallib
```

The package invokes the exact pins in `Package.resolved`. The build script
compiles KSPlayer's `Shaders.metal` to the required `default.metallib`; plain
SwiftPM resource processing only preserves the source `.metal` file.

## N-API contract (ABI v1)

Every addon method returns an object and reports bad input/runtime failures as
`{ ok: false, reason, message? }`; it never deliberately throws across the
N-API boundary.

```ts
getSupport(): {
  supported: boolean; reason?: string; architecture?: string; runtimePath?: string;
}
prepare(): { supported: boolean; reason?: string; architecture?: string }
diagnoseEmbedding(): EmbeddingDiagnostic | OperationResult
getEmbeddingDiagnostic(sessionId?: string): LiveEmbeddingDiagnostic | OperationResult
createSession(sessionId: string, nativeHandle: Buffer, bounds: Bounds): OperationResult
load(sessionId: string, url: string, headers?: Record<string, string>): OperationResult
setBounds(sessionId: string, bounds: Bounds): OperationResult
setPaused(sessionId: string, paused: boolean): OperationResult
seek(sessionId: string, seconds: number): OperationResult
setVolume(sessionId: string, volume: number): OperationResult
setAudioTrack(sessionId: string, trackId: number): OperationResult
setSubtitleTrack(sessionId: string, trackId: number): OperationResult
setSubtitleFile(sessionId: string, filePath: string): OperationResult
setSubtitleSettings(sessionId: string, settingsJSON: string): OperationResult
setPlaybackSpeed(sessionId: string, speed: number): OperationResult
setDisplayMode(sessionId: string, mode: string): OperationResult
setAspect(sessionId: string, aspect: string): OperationResult
setPicture(sessionId: string, pictureJSON: string): OperationResult
getSupportedControls(sessionId?: string): {
  pause: boolean; seek: boolean; volume: boolean;
  audioTracks: boolean; subtitles?: boolean; playbackSpeed: boolean;
  displayMode?: boolean; aspectOverride?: boolean; pictureAdjustments?: boolean; reason?: string;
}
getSnapshot(sessionId: string): Snapshot
disposeSession(sessionId: string): OperationResult
disposeAll(): OperationResult
```

`prepare()` returns the same support shape as `getSupport()` after selecting the
Metal renderer. `diagnoseEmbedding()` runs a detached layout proof (without a
session or playback) and returns `{ ok, initialFrame, updatedFrame,
childCountAfterAttach, childCountAfterDispose, reason? }`; each frame has numeric
`x`, `y`, `width`, and `height`. `getEmbeddingDiagnostic(sessionId?)` returns
geometry-only live evidence for the named session, the first active session when
omitted, or the last diagnostic; an unavailable result has `available: false`,
`ok: false`, `phase: "unavailable"`, and a `reason`. Both diagnostics can return
an `OperationResult` when the optional native diagnostic symbol or runtime is
unavailable. `OperationResult` includes `ok`, `backend: 'ksplayer-metal'`,
optional `reason`/`message`, the supplied `sessionId` when applicable, and an
optional `snapshot`; create/load/control successes include a current snapshot,
while `disposeSession` and `disposeAll` succeed without one. Failures include a
snapshot only when the runtime has one available. Normal runtime
`getSupportedControls` results include both `subtitles` and `displayMode`; the
native unavailable-controls fallback stably returns `pause`, `seek`, `volume`,
`audioTracks`, `playbackSpeed`, and `reason` while omitting those two optional
fields. A normal runtime `Snapshot` includes `backend`, `state`,
`positionSeconds`, `durationSeconds`, `paused`, `volume`, `resolution`,
`audioTracks`, `selectedAudioTrackId`, `subtitleTracks`,
`selectedSubtitleTrackId`, `playbackSpeed`, `aspectOverride`, `container`,
`videoCodec`, `audioCodec`, `fps`, `bitrate`, `droppedFrames`, `bufferedSeconds`,
`error`, and `message`. Native error/fallback snapshot objects may omit
`subtitleTracks` and other normal fields entirely, so callers must not assume
those fields are present. When present, `subtitleTracks` is an array of
`{ id: number; title?: string; language?: string; selected: boolean }` entries.
Normal loaded/session snapshots prepend the `Off` sentinel
`{ id: -1, title: "Off", selected }`; error and other empty/fallback snapshots
may omit the array entirely.
`setSubtitleTrack(sessionId, -1)` selects that sentinel, clears subtitles, and
sets `selectedSubtitleTrackId` (`number | null`) to `null`; selecting an
embedded or externally loaded track reports its integer id there.
`setSubtitleTrack` accepts integer numbers, `setSubtitleFile` accepts a URL or
absolute file path, and
`setSubtitleSettings` accepts a JSON string with the required
`fontSize`, `textColor`, `backgroundColor`, `backgroundOpacity`, `outlineSize`,
`position`, and `delaySeconds` fields. `setDisplayMode` remains an internal
fit/fill behavior control. `setAspect` accepts exactly `"no"`, `"16:9"`,
`"4:3"`, `"21:9"`, or `"2.35:1"`; its selected value is returned as
`aspectOverride`. The runtime applies the chosen ratio through KSPlayer's
direct-Metal DAR sizing hook while preserving the unchanged clipped host,
player-view, and subtitle-overlay bounds.
`setPicture` accepts a JSON object string containing all five shared picture
fields: `brightness`, `contrast`, `blackLevel`, `saturation`, and `gamma`.
Each must be a finite number in `-100...100`; invalid inputs return
`{ ok: false }`. The decoded direct-Metal shader uses the same semantics as the
browser-backed player: brightness/contrast scale the channels, black level is
an offset, saturation is clamped at zero, and gamma is clamped to a minimum
exponent of `0.1`. The accepted values are returned in `Snapshot.picture`.
KSPlayer Metal exposes audio-track selection, external and embedded subtitle
selection/settings, playback speed, MPV-compatible aspect overrides, internal
`fit`/`fill` display mode, and per-session picture adjustments.
`getSupportedControls().aspectOverride` and `.pictureAdjustments` are advertised
only when both the runtime and their additive addon methods are present; older
addons therefore remain usable without exposing unusable UI controls. For the concurrent
`EmbeddedMpvSession` lane, snapshots also expose compatible `status`,
`streamUrl`, `videoWidth`, and `videoHeight` aliases when those values are
known. Values unavailable from KSPlayer are left null/undefined rather than
fabricated.

All AppKit, Swift, and KSPlayer calls are serialized on the main actor. Player
views are child `NSView`s of Electron's BrowserWindow content view; this runtime
never creates an `NSWindow`. Packaged builds stage both
`KSPlayer_KSPlayer.bundle/Contents/Resources/default.metallib` and the resource
root `default.metallib` inside `ARM-Nator.app/Contents/Resources`; `prepare()`
validates the latter before creating a player.

## Seek recovery and comparison evidence

KSPlayer Metal uses the direct `MetalPlayView`/`CAMetalLayer` branch; it does
not substitute a sample-buffer or software renderer. For seek correctness the
runtime deliberately disables KSPlayer's retained-packet backward-seek replay:
on fully buffered local VOD that optimization can repopulate a stale output
queue after a seek. The normal FFmpeg seek resets the decoder and clocks as a
single operation. The maintained patch also commits the item clocks/read state
before invoking a seek completion, so a caller cannot resume the renderers
against a stale seeking clock. In-flight requests remain coalesced, timeout
recovery reloads the source, and generation guards ignore late completion after
recovery or disposal.

Run the focused real-host lifecycle proof after building:

```sh
node_modules/.pnpm/electron@41.7.2/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron-backend/ksplayer-metal/electron-embedding-harness.cjs
```

Run the reproducible same-fixture comparison with both addons built:

```sh
pnpm ksplayer-metal:build
pnpm embedded-mpv:build
pnpm player-backend:compare
```

It creates deterministic local H.264, HEVC, subtitle, and loopback-HTTP media
fixtures, then writes machine-readable results to
`tmp/player-backend-comparison/results/latest.json`. It measures startup and
seek latency, exposes available renderer/frame/resource data, and labels CPU
and any unavailable backend metric as unavailable. It is evidence collection,
not a claim that one backend is universally better.
