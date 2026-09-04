# ARM-Nator

ARM-Nator is a macOS Apple Silicon Electron media workspace. It imports Xtream
and Stalker sources, stores the Xtream catalog and shared state in SQLite,
provides search and refinement tools, and plays streams through several local
and browser-based engines.

This document describes the current repository rather than a historical
roadmap. The package version in this checkout is `0.31.0`.

## What is available now

- Xtream Code sources with movies, series, live TV, recently added, favorites,
  recently viewed, and global search views.
- Stalker portal sources with MAC authentication, live TV, movies, series,
  episode details, and shared-player playback.
- SQLite-backed Xtream catalog storage and shared state, indexed search,
  pagination, metadata enrichment, and case-insensitive refinement values.
- Global Search searches the local SQLite Xtream catalog; Stalker exposes its
  own portal-scoped search route and is not included in Global Search.
- Optional TMDB enrichment for on-demand detail views and the Dashboard
  trending rail. TMDB enrichment is separate from Xtream detail loading and
  does not scan the entire catalog when enabled.
- Release-year refinement that prefers release metadata and only falls back to
  an explicit or title-derived year when trusted release metadata is absent.
- Playback through ArtPlayer, ArtPlayer2, HTML5, Embedded MPV, KSPlayer, external MPV, and VLC.
- Shared playback controls for seeking, volume, speed, aspect ratio, tracks,
  subtitles, fullscreen, screenshots, and engine switching.
- Playback diagnostics for resolution, container/format, video and audio
  codecs, bitrate, buffer state, and common loading failures.
- Online subtitle search and download through OpenSubtitles from the player
  settings panel. A compatible OpenSubtitles API key must be configured for a
  shared or packaged build.
- Direct Play at `/workspace/tools/direct-play` for testing a URL, headers, and
  a selected player engine.
- Credential/bulk testing at `/workspace/tools/credentials` for Xtream
  credentials.
- An Electron Browser workspace and a YouTube workspace, both backed by
  persistent Electron `WebContentsView` sessions.
- YouTube ad filtering, SponsorBlock integration, an app mini-player, and
  Google sign-in navigation inside the YouTube tab.
- Light, dark, and system themes, configurable dashboard rails, favorites,
  recently viewed content, and persisted playback positions.

## Validation and production builds

The repository provides standard validation commands:

```bash
pnpm verify:environment
pnpm lint
pnpm test
pnpm test:angular         # Stalker Jest suites; accepts optional Jest configs
pnpm build
```

`pnpm test` runs the repository's Node built-in test suites through the shared
test runner. Angular/Jest suites are separate; `pnpm test:angular` runs the
Stalker Jest configurations (or explicit configs passed to that script).
Production builds prepare the pinned Embedded MPV runtime automatically when it is
not already staged. Runtime compilation requires
macOS on Apple Silicon plus `meson`, `ninja`, and `pkg-config`.
The production `build` and `package` lifecycle hooks verify the pinned
environment and rebuild Electron-native dependencies for Electron 41 before
they run. Development reuses the native player artifacts already present in
`apps/electron-backend/native/build/Release/` so normal renderer restarts do
not rebuild Swift, Metal, and MPV toolchains.

For a faster iterative workflow, run `pnpm embedded-mpv:runtime` once and the
subsequent native builds reuse the staged runtime under
`vendor/embedded-mpv/darwin-arm64`.

## Playback and media limitations

The player engine determines which streams can be decoded. H.264/AAC and
common MP4/HLS/DASH streams are the most broadly compatible. H.265/HEVC,
unusual containers, audio codecs, and hardware acceleration depend on the
selected engine, the embedded runtime, and macOS support. The diagnostics panel
reports the format and codec information that the active engine exposes.

Browser playback uses the web media stack and Shaka integration where a DASH
manifest requires it. ClearKey can be configured directly. Widevine and
PlayReady require all of the following:

1. A provider-supplied license server.
2. Any required authorization or license request headers.
3. A compatible browser CDM available to the Electron runtime.

Embedded MPV, external MPV, and VLC are intended for clear streams. The app
does not bypass DRM, decrypt protected content, or turn a protected provider
stream into a clear stream.

YouTube links should be opened in the YouTube workspace. Direct Play is for
direct media or provider stream URLs; a normal YouTube page URL is not itself
a downloadable media stream and may fail in a generic player engine.

## Product boundaries

- Runtime: macOS arm64 Electron.
- Renderer: one Angular desktop application.
- Main process: Electron services, typed IPC, SQLite access, workers, browser
  views, and native Embedded MPV integration.
- Active source types: Xtream and Stalker portal.
- Active player engines: ArtPlayer, ArtPlayer2, HTML5, Embedded MPV, KSPlayer, external MPV, and VLC.
- Browser and YouTube are Electron-hosted features. A normal browser is only
  supported for the development loopback bridge; there is no separate PWA
  product.
- The old Downloads feature, remote-control/server surfaces, and Video.js are
  not active product features.

## Routes and tools

| Route | Purpose |
| --- | --- |
| `/workspace/dashboard` | Configurable dashboard rails |
| `/workspace/sources` | Source and playlist management |
| `/workspace/stalker/:id/itv` | Stalker live TV categories and channels |
| `/workspace/stalker/:id/vod` | Stalker movies and movie details |
| `/workspace/stalker/:id/series` | Stalker series, seasons, and episodes |
| `/workspace/search` | Global catalog search |
| `/workspace/global-favorites` | Favorites across sources |
| `/workspace/global-recent` | Recently viewed content |
| `/workspace/browser` | General Electron browser view |
| `/workspace/youtube` | YouTube-focused browser view |
| `/workspace/tools/direct-play` | Play a URL with a selected engine |
| `/workspace/tools/credentials` | Test Xtream credentials in bulk |
| `/workspace/settings` | Application, player, source, and dashboard settings |

Xtream routes are mounted below `/workspace/xtreams/:id` for live, VOD,
series, search, actor/filmography, recently added, favorites, and recent
views. Stalker routes are mounted below `/workspace/stalker/:id` for ITV, VOD,
series, recently added, and portal search.

## Architecture

```text
Angular feature
  -> typed provider/service contract
  -> PlayerFacade or typed Electron preload bridge
  -> Electron service, worker, SQLite, HTTP, or native MPV
```

The workspace owns the persistent playback session. Provider pages resolve
media and navigation callbacks; they do not create independent player
sessions. `@arm-nator/player/core` owns player registration, engine
classification, availability, and the `PlayerFacade` contract.

Electron main-process code owns database initialization and native/browser
resources. Renderer code uses typed services and preload APIs rather than
opening SQLite or Node APIs directly.

## Repository layout

```text
apps/
├── desktop-ui/                  Angular renderer, routes, and app bootstrap
└── electron-backend/            Electron main process, IPC, workers, and native code

libs/
├── providers/                   Xtream, Stalker, and shared catalog features
├── workspace/                   Desktop shell, dashboard, and navigation
├── player/                      Player contracts, engines, controls, and diagnostics
├── database/                    SQLite schema and connection runtime
├── browser/                     Browser, YouTube, ad-filter, and SponsorBlock contracts
├── services/                    Shared renderer/runtime services
├── settings/                    Settings data access and UI
├── shared/                      Interfaces, IPC contracts, and utilities
├── tools/                       Direct Play and credential tester features
└── ui/                          Reusable presentation components

tools/                           Build, packaging, fixture, and graph helpers
vendor/                          Vendored Embedded MPV arm64 runtime inputs
graphify-out/                    Local/generated Graphify working data when present
```

Keep Angular features thin. Put provider-specific state in the matching
provider library, keep shared catalog UI in `providers/shared`, and keep
Electron or native implementation details behind typed contracts.

## Database

The shared database library owns the Drizzle schema and SQLite connection
utilities. The main catalog tables are:

- `playlists`
- `app_state`
- `categories`
- `content`
- `recently_viewed`
- `favorites`
- `playback_positions`
- `tmdb_metadata`

The default database path is:

```text
~/.arm-nator/databases/arm-nator.db
```

The catalog stores provider and metadata text because it supports search,
refinement, diagnostics, and offline UI state. Xtream catalog rows are imported
into SQLite; Stalker VOD, series, and ITV catalogs are loaded from the portal
on demand, while connection identity and user state are persisted locally. The
database does not store poster image files; poster and backdrop values are URL
metadata. SQLite access remains in Electron/main-process services.

Xtream movie and series detail metadata is persisted when it is fetched from the
provider. Global Search itself does not contact providers while the user types;
it currently searches Xtream rows only. Stalker search remains portal-scoped
and on demand.

TMDB data is stored separately in `tmdb_metadata`. It is optional, cached
locally, and fetched on demand for supported detail, person, season, hero, or
trending views.

Provider credentials are currently stored in the local SQLite connection data;
there is no macOS Keychain integration in this version. Xtream backups include
secrets when the user explicitly exports a backup, so backup files must be
handled as sensitive data.

## Embedded MPV

Embedded MPV is part of the ARM-Nator application in development and in the
packaged `.app`. It uses the vendored macOS arm64 runtime; Homebrew libraries
are not release inputs. External MPV and VLC are optional managed players and
must be installed/configured separately when those engines are used.

Required development inputs are macOS, Xcode Command Line Tools, Node.js,
pnpm through Corepack, and the vendored MPV runtime.

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

## Development

```bash
pnpm install --frozen-lockfile
pnpm verify:environment
pnpm dev                  # Electron + Angular watch mode
pnpm dev:native            # Refresh Electron + MPV + KSPlayer native artifacts
pnpm rebuild:native        # Rebuild better-sqlite3 after Electron/dependency changes
pnpm build                # Production desktop build
pnpm package              # Ad-hoc-signed macOS arm64 package
pnpm embedded-mpv:runtime # Stage/verify the vendored MPV runtime
pnpm embedded-mpv:build   # Build the native Embedded MPV addon
pnpm player:fixtures      # Run player stream fixture tooling
pnpm clean                # Remove generated build output
```

`pnpm dev` is the normal development workflow. The Angular renderer is served
at `http://localhost:4300` while Electron runs the desktop window.

The same development command also exposes a loopback web data adapter at
`http://127.0.0.1:4310/api` after SQLite initialization. Opening
`http://localhost:4300` in a normal browser uses this adapter for playlists,
catalogs, favorites, recently viewed items, playback positions, app state, and
Xtream requests. The adapter forwards to the existing database worker; it does
not open or copy the SQLite file in the browser. Set
`ARM_NATOR_WEB_API_PORT` before starting Electron to change the API port.

Native-only features such as MPV/VLC launching and Electron BrowserViews remain
available only in the desktop app.

When validating large Xtream catalogs, verify that the imported catalog loads
quickly, then open representative movies and series to confirm that detailed
provider metadata is fetched on demand and appears in Global Search afterward.

## Verification

Useful targeted checks are:

```bash
pnpm exec nx run player-ui:lint
pnpm exec nx run shared-interfaces:build
pnpm build
```

The native build requires the vendored MPV runtime to be present. Packaged
builds also validate the embedded runtime and macOS arm64 packaging inputs.

## Graphify

Graphify is a navigation aid for file and symbol relationships. Its output is
local/generated data and is not the product status source. When the Graphify
tool is available, refresh it after substantial code changes with:

```bash
graphify update
```

Do not put machine-specific absolute paths in project documentation.

## Maintenance rules

When changing a feature:

1. Update the route, contract, or runtime note above if its user-facing scope
   changes.
2. Keep provider normalization before shared UI consumption.
3. Keep Electron and native code behind typed preload/IPC boundaries.
4. Add or update targeted verification for playback, database, or provider
   changes.
5. Keep generated artifacts and local Graphify output out of the canonical
   product description.
6. Keep `README.md` current for shipped behavior and `docs/PRD.md` current for
   product requirements and release intent.
