# Feature foundation

This repository is prepared for the next feature phase without changing the
current player behavior or exposing unfinished screens.

## Domain boundaries

- `libs/player/core`: one application-facing playback request, command,
  information, capability, snapshot, and diagnostic model for every existing
  player engine.
- `libs/tools/core`: direct URL playback, playback URL copying, credential batch
  testing, and stable route identifiers.
- `libs/browser/core`: browser tabs, navigation commands, ad filtering, YouTube
  sessions, and SponsorBlock contracts.

The contracts are framework-free. Angular features and Electron services can
implement them without importing each other's internals.

## Existing engines remain supported

- ArtPlayer
- HTML5
- Embedded MPV
- External MPV
- VLC

No engine was hidden, removed, or behaviorally changed by this preparation.
Video.js remains intentionally absent.

## Implementation order

1. Add a playback session store implementing `PlaybackObservability`.
2. Adapt each player engine into `PlaybackController`.
3. Build Direct Play and playback information/diagnostics UI.
4. Add credential tester Electron worker and UI.
5. Add Electron `WebContentsView` tab manager and browser shell.
6. Implement request filtering for the browser partition.
7. Add YouTube-specific navigation and SponsorBlock client.

## Electron boundary

Browser pages must run in their own persistent Electron session partition, not
inside the Angular renderer. This is a reliability boundary for arbitrary web
content, not an offline restriction. The browser and YouTube tabs retain normal
internet access.

Feature implementations should expose narrow typed methods through preload only
after their IPC handlers exist. The preparation intentionally does not publish
nonfunctional preload methods.

## Credential testing

The batch tester contract supports controlled concurrency, cancellation,
latency, HTTP status, account metadata, and progressive results. Inputs and
results may remain unredacted because this application is for personal,
single-machine use.

## Final route targets

- `/workspace/tools/direct-play`
- `/workspace/tools/credentials`
- `/workspace/browser`
- `/workspace/youtube`

These paths are reserved in `DESKTOP_TOOL_ROUTES`; they are not registered in
Angular until their feature components exist.
