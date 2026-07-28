# Feature foundation

This repository is prepared for the next feature phase. The shared playback
foundation and Direct Play observability work are implemented; unfinished
credential and browser tools remain unpublished.

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

## Implementation status

1. Done: persistent workspace playback session and runtime observability.
2. Done: shared playback boundary for every retained player engine.
3. Done: Direct Play, diagnostics, unified controls, engine switching,
   expanded player, mini-player, tracks, seek, screenshot, and media health.
4. Planned for 25.x.x: credential tester Electron worker and UI.
5. Planned for 25.x.x: Electron `WebContentsView` tab manager and browser shell.
6. Planned for 25.x.x: request filtering for the browser partition.
7. Planned for 25.x.x: YouTube navigation, ad filtering, and SponsorBlock.

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
