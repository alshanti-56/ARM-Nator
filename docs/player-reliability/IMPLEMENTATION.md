# Player reliability implementation

Status: Stage 1 is implemented for the Electron development app and packaged macOS app. Stage 2’s companion service and Stage 3’s compatibility conversion are deferred; neither is part of this release. The Stage 1 native-memory acceptance check remains open for MPV’s default OpenGL renderer, as described below.

## Scope

- Supported release targets: Electron development builds and the packaged macOS desktop app, including embedded MPV, KSPlayer, and the browser-based player.
- Standalone Chrome, Edge, Firefox, and Safari delivery is outside this release scope.
- Companion configuration and conversion settings are not exposed in playback settings. No companion or conversion service is enabled by default.
- Existing buffering defaults remain unchanged. External applications are offered only after in-app recovery and are never launched automatically.

## Stage 1 implementation

- A shared attempt manager applies capability-aware engine selection, verified playback progress, failure categories, bounded retry budgets, stale-result rejection, and a six-action rolling recovery limit.
- Manual engine selection gets the first attempt. Automatic recovery can renew a provider link once where supported, and stops on terminal account, DRM, or resource failures.
- Recovery keeps VOD position, pause, volume, mute, speed, and semantically matched audio/subtitle tracks. Live playback returns to the live edge unless DVR seeking is supported.
- Pause and seek suppress or reset stall handling. Retry and Close remain reachable while loading, after failure, and during engine replacement. Native replacement waits for confirmed teardown and stops if cleanup fails.
- Successful compatible engines are remembered for seven days by source, content type, media characteristics, and runtime version. Network failures do not invalidate that preference.
- Auto now uses failure evidence to choose provider-supplied source alternatives within the existing three-attempt episode and six-action rolling limits. DNS failures can move to a known alternate host; rejected or missing media can use known host/format alternatives after a supported link renewal. It skips previously attempted source URLs and hosts that failed DNS, and retains a usable alternate host when changing between matching provider-supported HLS/TS siblings. It does not guess arbitrary provider hosts or media paths.
- HTTP throttling remains a delayed retry, including during initial stream preparation: `Retry-After` survives inspection and IPC. Auto stops if that delay exceeds the remaining recovery window. Decoder switching, cancellation, teardown ownership, and terminal DRM handling retain their existing policies.
- Embedded KSPlayer no longer creates a second system picture-in-picture controller for ARM-Nator’s own floating player; its existing lazy PiP path could retain closed player views.
- Embedded MPV teardown drains and releases its per-session render queue, completes outstanding OpenGL work, detaches the OpenGL drawable, and then releases the native session.
- The fixture benchmark can use the bundled FFmpeg and selected native addon, isolate each session, use nearest-rank p95, and verify startup, seeking, progress, and cleanup.

## Auto source memory and activity

Auto remembers a provider/account’s host origin and stream format after thirty seconds of advancing playback with frame evidence (or confirmed audio-only progress). Live and recorded viewing have separate preferences. Preferences survive restart, expire after seven days, and are scoped to the playback runtime. The next selection resolves that choice against its own current provider metadata; no old channel URL is reused. Unknown identities and DRM routes do not use remembered source choices. Stored entries contain opaque host/account fingerprints, format, runtime and timestamp, without stream paths, query strings or credentials.

A matching source failure clears the preference, including DNS failures, rejection, network errors, startup timeouts, stalls and HTML returned instead of media. Before thirty-second verification, a failed remembered host/format yields to the current channel’s configured route once, within the same attempt and time budgets. This also applies to startup watchdog failures. The configured route restores its original provider alternatives and preserves recorded playback position. Supported account renewal takes priority and replaces the original URL and recovery metadata with the fresh result, so expired routes cannot leak into later attempts. A stale renewal cannot clear a newer selection’s configured fallback.

Temporary DNS errors (`EAI_AGAIN`) can retry with the existing backoff when no usable alternative is available; they do not blacklist the hostname. Permanent DNS failures retain the known-host fallback policy. HTTP 429 preserves the preference and retains the existing bounded retry policy. Decoder, autoplay and DRM failures do not count against the source choice or trigger the configured-source fallback. Explicit manual player/source recovery keeps the selected source.

The player’s collapsible **Auto activity** section shows each attempted host, format and player, playback progress, thirty-second verification, recovery explanation and final stop reason. It retains verification after stopping or a later failure, resets for a new selection, ignores stale callbacks and keeps the most recent twenty attempts in memory. History uses fixed explanations and host names rather than raw provider error messages or full URLs. Expanding it shrinks the native video aperture instead of covering the native player.

Automated coverage checks current-channel route resolution after a preference-store restart, expiry and isolation, invalidation, frame-progress gating, cancellation and late player-start errors, history privacy and rendered collapsible UI behaviour. These checks do not establish that every provider or stream works; current-provider viewing remains a separate acceptance check.

## Verification

- `pnpm test`: 684 Node tests passed.
- `pnpm test:angular`: 54 Jest suites and 711 tests passed. Two Stalker pure-utility specs use `node:test`; they remain in the Node suite and are excluded from Jest discovery.
- Final native playback comparison passed H.264 and HEVC MP4 (three runs per engine), loopback HLS with MPEG-TS segments, subtitle selection, VOD seeking, and six-second progress checks in both KSPlayer and MPV.
- A 30-sample startup comparison against the prior packaged baseline stayed within the larger of 250 ms or 10%: KSPlayer p95 was 166→167 ms (H.264) and 164→167 ms (HEVC); MPV was 290→278 ms and 271→277 ms.
- A 10-second 4K H.264 fixture advanced at 30 fps in MPV OpenGL. MPV software rendering also advanced at 30 fps, but used about 10.4% of Electron host CPU versus 2.8% for OpenGL; OpenGL therefore remains the default.
- The corrected 100-cycle mixed-engine soak cancelled all 200 sessions during active upstream reads. It recorded zero playback failures, zero socket timeouts, zero remaining sockets, and no extra player processes (four helper children at start and finish).
- The mixed OpenGL soak showed elevated private memory while sessions were repeatedly opened and closed. After ten seconds idle, one 100-cycle run retained about 16 MB above its initial sample; a later 50-cycle run with explicit GPU completion retained about 5.5 MB. MPV-only and KSPlayer-only idle measurements returned close to their starting values. The result varies by run, so the strict no-growth memory gate is not claimed as passed for mixed OpenGL sessions.
- A 50-cycle mixed test with MPV software rendering had no playback/socket/process failures, a slightly negative memory slope, and lower memory after idle. It costs more CPU at 4K and its 4K HEVC behavior was not established, so it was not made the default.
- The packaged app is `dist/executables/mac-arm64/ARM-Nator.app`. It contains both native player addons and the bundled FFmpeg. With `ARM_NATOR_ADHOC_SIGN=1`, `codesign --verify --deep --strict` passes.
- System FFmpeg was not installed; verification used the FFmpeg already bundled with the app.

## Remaining Stage 1 limitations

- Investigate the variable private-memory increase when OpenGL MPV and KSPlayer are alternated rapidly. Active sessions, sockets, queues, player processes, and session ownership all returned to zero/stable counts in the soak; the remaining measurement is process-private memory after repeated native view creation.
- The fixture checks do not represent every IPTV provider, authentication policy, codec, subtitle format, or live adaptive stream. Real-world expired links, throttling, and provider rejection still depend on provider responses.
- Native subtitle compositing is not captured by the benchmark; track choice and restoration are checked separately.
- Windows, Linux, and standalone browser playback are outside the agreed desktop release scope.

The Auto source-memory/activity test build is `tmp/auto-startup-recovery/mac-arm64/ARM-Nator.app`; the earlier native benchmark package path above remains its historical artifact.

## Verification artifacts

- Final 30-sample p95 report: `/tmp/arm-stage1-startup-final.json`.
- Final native format/endurance report: `/tmp/arm-stage1-final-functional.json`.
- Active-socket 100-cycle mixed OpenGL report: `/tmp/arm-stage1-mixed-active-cleardrawable-100.log`.
- Active-socket 50-cycle mixed renderer comparison: `/tmp/arm-stage1-mixed-software-active-50.log` and `/tmp/arm-stage1-mixed-glfinish-active-50.log`.
- Test command output is available in the current terminal run; no test or diagnostic app process was left running.

The app’s two JavaScript dialogs shown during verification came from temporary Electron diagnostic scripts named in their stack traces, not from the player UI. Those scripts are not part of the app and were not used for the final package check.
