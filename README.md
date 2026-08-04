# ARM-Nator

ARM-Nator is a macOS Apple Silicon Electron media workspace. It imports M3U
and Xtream sources, stores catalog data in SQLite, provides search and
refinement tools, and plays streams through several local and browser-based
engines.

This document describes the current repository rather than a historical
roadmap. The package version in this checkout is `0.24.0`.

## What is available now

- M3U imports from files, text, and URLs.
- Xtream Code sources with movies, series, live TV, recently added, favorites,
  recently viewed, and global search views.
- SQLite-backed catalog storage, indexed search, pagination, metadata
  enrichment, and case-insensitive refinement values.
- Per-Xtream-source metadata indexing status on the Sources page, including
  indexed/total counts, progress, queued work, and a Start indexing action.
- Provider metadata indexing uses a bounded single-source queue, skips complete
  records, and keeps failed records retryable without repeatedly re-indexing the
  entire catalog.
- Global Search searches the local database across Xtream and M3U sources;
  title search is available after import while metadata search improves as
  each Xtream source is indexed.
- Optional TMDB enrichment for on-demand detail views and the Dashboard
  trending rail. TMDB enrichment is separate from provider metadata indexing
  and does not scan the entire catalog when enabled.
- Release-year refinement that prefers release metadata and only falls back to
  an explicit or title-derived year when trusted release metadata is absent.
- Playback through ArtPlayer, HTML5, Embedded MPV, external MPV, and VLC.
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
  credentials and M3U URLs.
- An Electron Browser workspace and a YouTube workspace, both backed by
  persistent Electron `WebContentsView` sessions.
- YouTube ad filtering, SponsorBlock integration, an app mini-player, and
  Google sign-in navigation inside the YouTube tab.
- Light, dark, and system themes, configurable dashboard rails, favorites,
  recently viewed content, and persisted playback positions.

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
- Active source types: M3U file/text/URL and Xtream.
- Active player engines: ArtPlayer, HTML5, Embedded MPV, external MPV, and VLC.
- Browser and YouTube are Electron-hosted features, not generic browser-only
  routes.
- PWA/browser-only runtime paths, the old Downloads feature, Stalker, remote
  control/server surfaces, and Video.js are not active product features.

## Routes and tools

| Route | Purpose |
| --- | --- |
| `/workspace/dashboard` | Configurable dashboard rails |
| `/workspace/sources` | Source and playlist management, including per-source Xtream metadata indexing |
| `/workspace/search` | Global catalog search |
| `/workspace/global-favorites` | Favorites across sources |
| `/workspace/global-recent` | Recently viewed content |
| `/workspace/browser` | General Electron browser view |
| `/workspace/youtube` | YouTube-focused browser view |
| `/workspace/tools/direct-play` | Play a URL with a selected engine |
| `/workspace/tools/credentials` | Test credentials and M3U sources in bulk |
| `/workspace/settings` | Application, player, source, and dashboard settings |

Source-specific movie, series, live TV, recently added, and advanced-search
routes are mounted below the workspace shell.

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
├── providers/                   M3U, Xtream, and shared catalog features
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
refinement, diagnostics, and offline UI state. It does not store poster image
files as part of the catalog database; poster and backdrop values are URL
metadata. SQLite access remains in Electron/main-process services.

Xtream movie and series rows also track metadata enrichment status, attempt
time, and retry time. The Sources page reads aggregate counts from SQLite so
it does not load every catalog row merely to render indexing status. Metadata
detail requests are performed through the provider API and persisted in paced
batches; Global Search itself does not contact providers while the user types.

TMDB data is stored separately in `tmdb_metadata`. It is optional, cached
locally, and fetched on demand for supported detail, person, season, hero, or
trending views.

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
pnpm dev                  # Electron + Angular watch mode
pnpm build                # Production desktop build
pnpm package              # Ad-hoc-signed macOS arm64 package
pnpm embedded-mpv:runtime # Stage/verify the vendored MPV runtime
pnpm embedded-mpv:build   # Build the native Embedded MPV addon
pnpm player:fixtures      # Run player stream fixture tooling
pnpm clean                # Remove generated build output
```

`pnpm dev` is the normal development workflow. The Angular renderer is served
at `http://localhost:4200` while Electron runs the desktop window.

When validating large Xtream catalogs, open `/workspace/sources` first. Start
one source at a time, observe its indexed/total progress, and then verify
Global Search against metadata fields such as cast, genre, director, and plot.

## Verification

Useful targeted checks are:

```bash
pnpm exec nx run providers-m3u-utils:lint
pnpm exec nx run providers-m3u-utils:build
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
