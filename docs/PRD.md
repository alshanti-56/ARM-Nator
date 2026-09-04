# ARM-Nator implementation snapshot

**Status:** Derived from the source tree
**Product version:** 0.31.0
**Date:** 2026-09-04

This document records behavior that exists in this checkout. The code is the
source of truth; when this document disagrees with the implementation, the
implementation wins. Items in the final section are known gaps or deliberate
follow-up work, not current product capabilities.

## Product

ARM-Nator is a macOS arm64 Electron media workspace. The Angular renderer uses
typed preload contracts to reach Electron services, database workers, provider
HTTP clients, browser views, and native playback integrations.

The supported source types are:

- **Xtream:** server URL, username, and password. Catalog rows are imported
  into SQLite for local browsing, indexed search, refinement, favorites,
  recently viewed items, and playback positions.
- **Stalker:** portal URL and MAC address, with optional identity fields and
  credentials. Portal ITV, VOD, and series data are loaded on demand; the app
  persists the connection identity and user state locally.

## Current user flows

### Add and maintain a source

The Sources UI adds, edits, refreshes, disables, and deletes connections. Xtream
forms normalize and validate HTTP(S) server URLs and credentials. Stalker forms
validate the portal URL and MAC, can derive device identifiers, and run portal
discovery before saving a session identity. Credential testing is available for
Xtream sources at `/workspace/tools/credentials`.

Xtream imports and database work run through the Electron database worker, so
the renderer does not open SQLite directly. Stalker discovery and portal
requests use the same validated request identity and URL utilities in the main
process or loopback HTTP bridge.

### Browse and search

Xtream has source-scoped live, VOD, series, recently-added, favorites, recent,
actor, and search routes. Stalker has ITV, VOD, series, recently-added, and
portal-search routes. Both source types use the shared player and shared user
state surfaces where their data supports them.

**Global Search is Xtream-only.** It queries the local SQLite FTS/search tables
and bounded fallback scans; it does not issue a provider request for each
keystroke. It searches the metadata currently stored for Xtream content,
including provider fields when those fields have been imported or fetched from
an opened detail view. Stalker search is portal-scoped and on demand.

Opening an Xtream movie or series can fetch its detailed provider record and
persist the returned metadata. TMDB is a separate, optional cache used by
supported detail/person/season/hero/trending views; enabling it does not scan
the whole catalog.

Favorites, recently viewed items, playback positions, dashboard preferences,
theme, and player preferences persist across restarts. Stalker portal catalog
data itself is not a durable local catalog: the ITV list is cached in session
memory and VOD/series data are requested from the portal as needed.

### Play and diagnose

The active engines are ArtPlayer, ArtPlayer2, HTML5, Embedded MPV, KSPlayer,
external MPV, and VLC. The player core classifies engines as web,
embedded-native, KSPlayer, or managed-external and reports runtime
availability. The shared facade exposes play, pause, stop, seek, volume, mute,
speed, track selection, diagnostics, and engine switching; UI features such as
subtitles, screenshots, aspect ratio, and fullscreen are available where the
engine contract supports them.

Direct Play at `/workspace/tools/direct-play` accepts a URL, optional headers,
and a selected engine. Diagnostics expose the URL/resolution, container,
codecs, bitrate, buffer state, tracks, and common loading failures. External
MPV and VLC are optional installed programs; Embedded MPV and KSPlayer depend
on staged native artifacts.

Browser playback uses the web media stack and Shaka integration for manifests
that require it. ClearKey configuration is supported. The app does not bypass
DRM or decrypt protected streams; Widevine and PlayReady require a compatible
CDM and provider license flow. Direct Play is intended for media/provider
stream URLs, not ordinary YouTube page URLs.

### Browser and YouTube workspaces

The Browser and YouTube workspaces are Electron `WebContentsView` features with
persistent sessions. General browser navigation is limited to HTTP(S). The
YouTube view has a YouTube host allowlist, ad filtering, SponsorBlock support,
Google sign-in navigation, fullscreen, and mini-player behavior within its
explicit preload/security boundary. External HTTP(S) links are opened by the
system browser; uncontrolled window creation and unsupported protocols are
rejected.

The normal browser path outside Electron is only a development feature. The
loopback API listens on `127.0.0.1:4310` by default (override with
`ARM_NATOR_WEB_API_PORT`) and exposes `/api/health`, `/api/db`, `/api/db/cancel`,
`/api/xtream`, and `/api/stalker`. It forwards to the existing database worker
and provider bridge; it does not expose SQLite or Node APIs to the browser.

## Routes

The root redirects to `/workspace`, and the workspace shell owns settings
initialization and startup-view redirects.

| Area | Routes |
| --- | --- |
| Dashboard and tools | `/workspace/dashboard`, `/workspace/tools/direct-play`, `/workspace/tools/credentials` |
| Shared views | `/workspace/sources`, `/workspace/search`, `/workspace/global-favorites`, `/workspace/global-recent`, `/workspace/filmography`, `/workspace/settings` |
| Browser | `/workspace/browser`, `/workspace/youtube` |
| Xtream | `/workspace/xtreams/:id` with `live`, `vod`, `series`, `search`, `actor/:personId`, `recently-added`, `favorites`, and `recent` branches |
| Stalker | `/workspace/stalker/:id` with `itv`, `vod`, `series`, `recently-added`, and `search` branches |

## Storage and security reality

The default SQLite database is:

```text
~/.arm-nator/databases/arm-nator.db
```

The schema includes `playlists`, `app_state`, `categories`, `content`,
`recently_viewed`, `favorites`, `playback_positions`, and `tmdb_metadata`, plus
SQLite FTS tables/triggers created during connection setup. The database
library has a normal read-write connection and an optional read-only/skip-table
mode for diagnostics or other consumers.

Provider credentials are currently stored in the local SQLite connection data
and serialized playlist payloads. TMDB settings, including its API key, are
stored in renderer settings storage. There is no Keychain integration in this
version. Xtream backup export intentionally includes secrets when the user
invokes it, so exported backup files are sensitive. Logging and trace helpers
redact sensitive values, but local secret storage remains a known gap.

Electron windows use `contextIsolation`, disabled Node integration, sandboxing,
web security, typed preload APIs, and explicit navigation rules. Provider HTTP
requests validate redirects and constrain browser CORS to local origins.

## Build, test, and release

The supported environment is Apple Silicon macOS with Node `22.23.1` and pnpm
`10.33.0`. `pnpm verify:environment` checks those requirements and the project
is arm64-only. Native build hooks use Electron 41 dependencies and require
`meson`, `ninja`, and `pkg-config` when the Embedded MPV runtime must be built.

Commands:

```bash
pnpm verify:environment
pnpm lint
pnpm test                 # Node built-in test files
pnpm test:angular         # Stalker Jest suites (or explicit configs)
pnpm build                # production desktop build
pnpm package              # ad-hoc-signed arm64 DMG/ZIP
```

The CI workflow runs lint, the Node test runner, and the production build on
`macos-15` arm64. The release workflow is tag-driven (`v*.*.*`), checks that
the tag matches `package.json`, builds Embedded MPV and KSPlayer artifacts,
publishes arm64 DMG/ZIP files and `SHA256SUMS.txt`, and currently uses ad-hoc
signing without notarization. The packaged app declares macOS 26.0 as its
minimum system version.

## Known gaps and follow-up work

These points are intentionally not described as implemented features:

- Credentials and API keys have not yet moved to macOS Keychain storage.
- Backup export is secret-bearing and needs stronger UX/documentation around
  handling the resulting file.
- The repository has separate Node and Angular/Jest test commands; there is no
  single command that executes every test framework.
- Public distribution signing, notarization, auto-update, crash reporting, and
  telemetry are not configured.
- Refresh behavior and partial-provider responses remain provider-specific;
  do not assume every failed refresh preserves a complete last-known catalog.
- Stalker catalogs are portal-backed/session-cached rather than equivalent to
  the durable Xtream SQLite catalog, so Global Search cannot treat them as the
  same data source.

## Maintenance rule

When behavior changes, update documentation only after tracing the relevant
implementation, tests, scripts, and workflow. Prefer exact route names,
commands, ports, storage locations, and capability boundaries over roadmap
language. Keep this snapshot and the README consistent with the source tree.
