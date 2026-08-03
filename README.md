# ARM-Nator

ARM-Nator is a macOS arm64 Electron media workspace with an Angular renderer,
M3U and Xtream sources, shared metadata/search, and multiple playback engines.
This README is the single product and architecture reference.

## Product boundary

- Runtime: macOS arm64 Electron only.
- Renderer: one Angular desktop application.
- Active sources: M3U and Xtream.
- Active playback engines: Embedded MPV, ArtPlayer, HTML5, external MPV, and VLC.
- PWA and browser-only runtime paths: removed.
- In-app Downloads and Stalker: removed. A startup migration deletes old
  Stalker playlists and drops the old downloads table. Remaining references are
  migration/rejection guards only.

Browser and YouTube are active Electron-hosted features. Direct Play is the
currently active tool route.

## v0.23.5

- Added separate resolution, container/format, and codec telemetry to Embedded
  MPV playback.
- Added ClearKey plus browser/Shaka DASH license-server plumbing for Widevine
  and PlayReady streams. Real playback still requires a provider license
  endpoint, authorization headers, and an available browser CDM.
- Improved metadata refinement with canonicalized genres and release-year
  prioritization from trusted metadata before title fallback.
- Added persistent Electron Browser and YouTube workspace behavior, including
  YouTube navigation, ad filtering, SponsorBlock integration, mini-player
  controls, and Google sign-in navigation.
- Improved Direct Play layout and removed the unused online-subtitle inputs.

## Current status

| Area | Status | Current state | Next work |
| --- | --- | --- | --- |
| Product shell | Implemented | Electron main process plus one Angular renderer and workspace shell | Keep new features behind typed boundaries |
| Sources | Implemented | M3U and Xtream providers with normalized shared contracts | Preserve provider normalization |
| Search | Implemented | Per-category and global search, scoring, pagination, SQLite indexes/FTS | Measure large-library performance |
| Filtering and sorting | Implemented | Category, rating, name/date/rating modes with paginated paths | Add only useful metadata filters |
| Metadata | Implemented | Titles, ratings, dates, posters, categories, provider payloads, TMDB hooks, canonicalized refinement values, and prioritized release years | Choose additional normalized/indexed fields |
| Playback foundation | Implemented | Shared session, engine switching, diagnostics, tracks, seeking, screenshots, media health | Add cross-engine regression coverage |
| Playback telemetry | Partial | Web buffer/codec/bitrate snapshots plus native MPV resolution, container, codec, and buffer snapshots | Verify MPV buffer-ahead thresholds |
| DRM | Partial | ClearKey and Shaka DASH license-server integration for Widevine/PlayReady | Validate provider-specific CDM, license, and header combinations |
| Lifecycle and memory | Partial | Listener teardown and native session disposal exist | Stress-test switching, routes, timers, observers, IPC, native sessions |
| Player controls | Implemented | Volume, tracks, subtitles, speed, aspect ratio, fullscreen, seek, episode navigation | Add shared gear-menu video adjustments |
| Video adjustments | Partial | Shared gear controls now drive browser filters and Embedded MPV picture properties; native black level is folded into brightness | Add OpenSubtitles search/attachment and refine engine-specific picture parity |
| Themes | Implemented | Light, dark, and system themes | Add tokenized accent colors and optional skins |
| Direct Play | Implemented | Diagnostics, URL copying, and engine selection at `/workspace/tools/direct-play` | Expand fixtures and failure reporting |
| Credential/bulk tester | Implemented | Typed Xtream/M3U batch testing with Electron worker IPC, progress UI, credential-inclusive CSV export, save-to-provider synchronization, and cancellation | Expand user-flow coverage |
| Browser | Implemented | Persistent Electron `WebContentsView` shell with navigation, session partitioning, bounds management, and mini-player support | Expand browser permissions and session controls |
| YouTube | Implemented | Persistent YouTube workspace with navigation, ad filtering, SponsorBlock, mini-player controls, and Google sign-in navigation | Validate account-specific flows and expand YouTube controls |

Status meanings: Implemented is active code; Partial is incomplete but running;
Contract only is typed preparation without a complete runtime; Planned is queued
work.

## Folder structure

```text
apps/
├── desktop-ui/                  Angular renderer, routes, app bootstrap
└── electron-backend/            Electron main process, IPC, native integration

libs/
├── providers/                   M3U, Xtream, and shared provider features
│   ├── m3u/                     state, utilities, player feature
│   ├── xtream/                  data access and catalog features
│   └── shared/                  normalized contracts, collection, playlist UI
├── workspace/                   desktop shell and dashboard
├── player/                      player contract and engine UI
├── database/                    SQLite schema and connection runtime
├── services/                    shared runtime services
├── shared/                      interfaces, contracts, logging
├── settings/                    settings data access and UI
├── ui/                          reusable non-player presentation
├── tools/                       Direct Play and tool contracts
└── browser/                     future Electron browser contracts

tools/                           build, packaging, Graphify, and native helpers
vendor/                          vendored Embedded MPV runtime inputs
graphify-out/                    generated graph reports and query memory
```

Keep `apps` thin. 

## Runtime boundaries

```text
Angular feature
  -> provider/service contract
  -> PlayerFacade or typed Electron preload bridge
  -> Electron service or worker
  -> SQLite, HTTP, or native MPV
```

The workspace owns one persistent playback session. Provider pages resolve media
and navigation callbacks; they do not mount independent player sessions.

`@arm-nator/player/core` owns supported-player registration, availability,
engine classification, and the `PlayerFacade` contract. Feature code must use
that boundary instead of importing player implementation details.

New browser pages belong in a persistent Electron session partition, not in an
arbitrary Angular web view. Add preload methods only with matching IPC handlers.

## Provider rules

- Normalize M3U and Xtream payloads before shared UI consumes them.
- Keep provider-specific API/state in the matching provider folder.
- Keep collection, playlist, navigation, and shared provider UI in
  `providers/shared`.
- Do not import Electron main-process or native-player internals into provider UI.
- Use Nx tags and module-boundary lint rules to enforce dependency direction.

## Credential/bulk tester

`/workspace/tools/credentials` parses up to 100 unique Xtream credentials or
M3U URLs and starts a typed batch through the preload bridge. Electron main owns
the batch ID, renderer ownership, terminal state, and one dedicated worker per
batch; the worker tests at most six sources concurrently. Progress snapshots and
CSV exports exclude passwords, URL userinfo, credential query values, and raw
input text. Stopping a batch requests cooperative abort and main-process worker
termination, then delivers one terminal snapshot. Saving working sources limits
M3U imports to three at a time and waits for SQLite persistence before state
hydration.

## Playback rules

Retained engines are protected: Embedded MPV, ArtPlayer, HTML5, external MPV,
and VLC. Do not remove, disable, or refactor their selection/configuration
without explicit approval. Video.js is absent.

Playback features publish resolved requests to the shared workspace host. The
host owns engine switching, stop/restart, screenshots, seeking, tracks,
diagnostics, media health, mini-player state, and external-player docking.

Browser DRM is handled by the Shaka engine for DASH manifests. ClearKey can be
configured directly; Widevine and PlayReady require provider-supplied license
servers and request headers. Embedded MPV, external MPV, and VLC remain
intended for clear streams unless a provider and engine-specific DRM path is
added later.

## Database

The shared SQLite library owns Drizzle schema and connection utilities. Active
tables are `playlists`, `categories`, `content`, `recentlyViewed`, and
`favorites`. The database lives at:

```text
~/.arm-nator/databases/arm-nator.db
```

Electron main-process code owns read/write initialization. Renderer code uses
typed services and preload APIs rather than opening SQLite directly.

## Dashboard

Dashboard rails are read-only views over existing playlist, recent, favorites,
and Xtream catalog data. Current rails include hero, continue watching, live
favorites, recently watched live, favorite movies/series, recent sources, and
recently added Xtream items. Visibility is controlled by
`Settings.dashboardRails`; the top-level `showDashboard` flag controls route
availability.

## Native Embedded MPV

Embedded MPV is part of the same ARM-Nator application in development and in
the packaged `.app`. Its separate source/build paths describe an internal
native boundary, not a separate product or process users launch.

Requirements: macOS, Xcode Command Line Tools, Node.js, pnpm through Corepack,
and the vendored arm64 MPV runtime. Development, production builds, and
packages require the vendored runtime; Homebrew runtime links are not release
inputs.

Homebrew is not an ARM-Nator runtime dependency. The repository mentions it
only to reject accidental Homebrew dylib links during packaging and to discover
optional external MPV/VLC installations. Embedded MPV in the packaged app uses
the vendored runtime.

Runtime sources and generated artifacts:

```text
vendor/embedded-mpv/darwin-arm64/
  include/mpv/client.h
  lib/*.dylib
  runtime-manifest.json

apps/electron-backend/native/build/Release/
  embedded_mpv.node
  embedded-mpv-runtime.json
  lib/*.dylib
```

Build or stage the runtime with `pnpm embedded-mpv:runtime`. Build the native
addon with `pnpm embedded-mpv:build`.

## Development

```bash
pnpm install --frozen-lockfile
pnpm dev       # Electron + Angular watch mode
pnpm build     # production desktop build
pnpm package   # ad-hoc-signed macOS arm64 package
pnpm clean
```

`pnpm dev` is the normal development workflow. The app currently serves the
Angular renderer at `http://localhost:4200` while Electron runs the desktop
window.

## Graphify

Graphify is a navigation aid for file and symbol relationships, not a status
source. Generated output is separate from this product document:

- [apps graph](graphify-out/runs/apps/GRAPH_REPORT.md)
- [historical libs graph](graphify-out/runs/libs/GRAPH_REPORT.md)
- [current libs graph](/Users/mohammadalshanti/Downloads/Arm-Nator/libs/graphify-out/GRAPH_REPORT.md)

Refresh after substantial code changes:

```bash
graphify update
```

Current libs graph includes provider libraries. Large graphs may skip HTML
visualization when they exceed the configured node limit.

## Documentation and maintenance

This file is the canonical project document. When a feature changes:

1. Update the relevant status row above.
2. Update folder or boundary rules if architecture changed.
3. Refresh the relevant Graphify graph.
4. Keep generated Graphify output separate and disposable.

Historical cleanup already completed: remote-control/server surfaces, PWA
runtime, Downloads UI/data, Stalker provider/runtime, and Video.js were removed.
Legacy database cleanup runs once at startup for existing user data.
