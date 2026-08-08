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
createSession(sessionId: string, nativeHandle: Buffer, bounds: Bounds): OperationResult
load(sessionId: string, url: string, headers?: Record<string, string>): OperationResult
setBounds(sessionId: string, bounds: Bounds): OperationResult
setPaused(sessionId: string, paused: boolean): OperationResult
seek(sessionId: string, seconds: number): OperationResult
setVolume(sessionId: string, volume: number): OperationResult
setAudioTrack(sessionId: string, trackId: number): OperationResult
setPlaybackSpeed(sessionId: string, speed: number): OperationResult
getSupportedControls(sessionId?: string): {
  pause: boolean; seek: boolean; volume: boolean;
  audioTracks: boolean; playbackSpeed: boolean;
}
getSnapshot(sessionId: string): Snapshot
disposeSession(sessionId: string): OperationResult
disposeAll(): OperationResult
```

`prepare()` returns the same support shape as `getSupport()` after selecting the
Metal renderer. `OperationResult` includes `ok`, `backend: 'ksplayer-metal'`, optional
`reason`/`message`, the supplied `sessionId` when applicable, and a current
`snapshot` on success. `Snapshot` includes `backend`, `state`,
`positionSeconds`, `durationSeconds`, `paused`, `volume`, `resolution`,
`audioTracks`, `selectedAudioTrackId`, `playbackSpeed`, `container`,
`videoCodec`, `audioCodec`, `fps`, `bitrate`, `droppedFrames`, `bufferedSeconds`,
`error`, and `message`. KSPlayer Metal currently exposes audio-track selection
and playback speed; subtitle, aspect-ratio, and picture-adjustment controls are
not advertised by this backend. For the concurrent
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
