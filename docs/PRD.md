# ARM-Nator Product Requirements Document

**Status:** Draft for product alignment
**Product version:** 0.23.5
**Date:** 2026-08-04
**Owner:** ARM-Nator product team

## 1. Product summary

ARM-Nator is a native macOS Apple Silicon IPTV and media workspace. It lets a user import M3U or Xtream sources, organize and search the resulting catalog, enrich content metadata, and play streams through the most appropriate local or browser-based engine.

The next product phase is focused on making the core experience dependable and easy to trust:

> Add a source, find something to watch, play it successfully, and return to it later.

The product should feel like a fast, private desktop media library rather than a collection of disconnected provider tools.

## 2. Problem statement

IPTV users commonly manage several provider sources, inconsistent metadata, unreliable stream URLs, and different playback requirements. Existing workflows force users to switch between playlist editors, web players, external media players, and provider portals.

ARM-Nator brings those workflows into one Apple Silicon desktop application, but the breadth of the current product increases the risk of inconsistent behavior across imports, catalog state, playback engines, browser views, and persisted credentials.

This PRD prioritizes reliability and clarity of the main user journey before adding more providers, playback engines, or secondary tools.

## 3. Goals

### Primary goals

1. Make source import predictable for M3U files, pasted text, URLs, and Xtream credentials.
2. Make large catalogs searchable, filterable, and navigable without blocking the desktop UI.
3. Make playback failure understandable and recoverable.
4. Preserve user state: favorites, recently viewed items, playback positions, settings, and source refresh behavior.
5. Establish a release-quality verification path for the packaged macOS arm64 application.
6. Protect provider credentials and prevent sensitive data from appearing in logs, diagnostics, or unintended exports.

### Secondary goals

1. Keep player-engine selection understandable to users.
2. Make browser and YouTube workspaces feel integrated without weakening Electron security boundaries.
3. Make provider-specific behavior invisible where a shared catalog experience is sufficient.

## 4. Non-goals

The following are explicitly out of scope for this phase:

- DRM circumvention, decryption, or turning protected streams into clear streams.
- A browser-only or PWA version of the product.
- Stalker or other inactive source types.
- A remote-control server, mobile companion, or multi-user backend.
- Adding additional playback engines before the existing engines meet reliability targets.
- Building a general-purpose web browser beyond the existing Electron browser workspace.
- Replacing the Angular/Nx/Electron architecture with a new framework.

## 5. Target users

### Primary user: desktop IPTV viewer

Uses one or more provider subscriptions and wants a single macOS application for importing, browsing, searching, and watching content.

Needs:

- Fast setup with minimal provider-specific knowledge.
- Reliable playback with clear recovery guidance.
- Favorites and resume support.
- Confidence that credentials and personal settings remain local and protected.

### Secondary user: power user / source manager

Maintains many M3U or Xtream sources and needs bulk testing, refresh, filtering, and source-level organization.

Needs:

- Clear source health and refresh status.
- Safe credential testing and export controls.
- Predictable behavior for duplicate, expired, or malformed sources.

### Tertiary user: technical troubleshooter

Diagnoses why a stream fails across browser, HTML5, Embedded MPV, external MPV, or VLC.

Needs:

- Diagnostics for URL, headers, codec, container, bitrate, buffering, and engine state.
- Reproducible direct-play testing.
- Logs that are useful without leaking credentials.

## 6. Product principles

1. **Playback is the product.** Every catalog feature should help the user reach successful playback faster.
2. **Provider differences belong behind contracts.** Shared UI should not understand provider-specific payloads.
3. **Failures should explain the next action.** “Playback failed” is not sufficient.
4. **Local-first by default.** Catalog state, settings, and playback positions should remain local unless a user explicitly invokes an external service.
5. **Secure boundaries are product features.** Electron IPC, browser views, native MPV, credentials, and file writes require explicit contracts and validation.
6. **No silent data loss.** Imports, refreshes, migrations, deletes, and resets must be recoverable or clearly confirmed.

## 7. Core user journeys

### Journey A: first source to first playback

1. User opens ARM-Nator.
2. User chooses Add Source.
3. User selects M3U file, M3U text, M3U URL, or Xtream credentials.
4. App validates the input and shows a clear preview or connection result.
5. App imports the source in the background and reports progress.
6. User sees the source and its available categories.
7. User searches or browses to a title/channel.
8. User starts playback.
9. If the selected engine cannot play the stream, the app explains why and offers an appropriate alternative when available.
10. The app stores the playback position and returns the user to the same source context later.

### Journey B: returning viewer

1. User opens the dashboard.
2. User sees recently viewed and in-progress content.
3. User resumes an item or opens a favorite.
4. The app restores the appropriate source, episode, position, and playback settings.

### Journey C: source maintenance

1. User opens Sources.
2. User sees source type, last refresh, item count, and health state.
3. User manually refreshes or enables auto-refresh.
4. App runs refresh work off the UI thread, reports progress, and preserves the previous catalog if the refresh fails.
5. User can edit, disable, export, or remove the source with an explicit confirmation for destructive actions.

### Journey E: preparing global search

1. User opens Sources and sees metadata coverage for each Xtream source.
2. The app reports indexed items as `indexed / total`, where total includes movies and series in that source.
3. User starts indexing for one source, or resumes a source with incomplete coverage.
4. The app displays live progress and keeps the completed state visible after indexing finishes.
5. If several sources are started, the app queues them and processes one source at a time to avoid overwhelming provider servers.
6. User searches globally across all imported sources. Titles are available after import; metadata fields become progressively available as each source is indexed.

### Journey D: troubleshooting playback

1. User opens Direct Play or playback diagnostics.
2. User supplies a URL and optional headers.
3. User selects an engine or lets ARM-Nator choose.
4. App reports network, manifest, codec, container, buffer, and engine information.
5. User can retry, switch engine, copy a sanitized diagnostic summary, or open the stream in an external player.

## 8. Functional requirements

### 8.1 Source management

**FR-1. Supported source types**

The product must support:

- M3U file import.
- M3U text import.
- M3U URL import.
- Xtream server URL, username, and password import.

**FR-2. Validation**

Before committing a source, the app must validate required fields, supported protocols, credential shape, and basic source reachability where applicable.

**FR-3. Import progress**

Long-running imports must run outside the renderer’s blocking path and expose progress, current phase, item counts, cancellation where safe, and a terminal success or failure state.

**FR-4. Failure preservation**

An unsuccessful refresh must not silently replace a working catalog with an empty or partial catalog.

**FR-5. Source lifecycle**

Users must be able to view, edit, refresh, disable, export, and delete sources. Delete and reset actions require a clear confirmation and must explain what data will be removed.

### 8.2 Catalog and discovery

**FR-6. Catalog views**

The app must provide source-specific and global views for live TV, movies, series, recently added, favorites, recently viewed, and search results where the source supports them.

**FR-7. Search**

Search must support title and relevant metadata, pagination or bounded result sets, case-insensitive matching, and predictable empty/error states.

Global Search must query the local database across all Xtream and M3U sources. It must not make a provider request for every search keystroke. Search completeness for genre, cast, director, release date, and description must reflect the metadata coverage of each source.

**FR-8. Refinement**

Where metadata exists, users must be able to refine by category, genre, year, language or other supported provider fields. Refinement values should be normalized consistently.

**FR-9. Metadata enrichment**

Provider metadata indexing and TMDB enrichment are separate capabilities:

- Xtream indexing retrieves detail metadata from the selected provider and stores searchable fields in the local catalog database.
- The Sources page must expose per-Xtream-source state: not indexed, queued, indexing, ready, or indexed with failures.
- The Sources page must provide indexed/total counts, progress, and a Start/Resume action for incomplete sources.
- Completed records must be skipped on later runs. Failed records must use bounded retry behavior and must not force a full re-index.
- Indexing must use a shared single-source queue across manual actions and automatic playlist-route indexing. A source action must never create a duplicate crawl.
- M3U sources remain limited to metadata supplied by the M3U import; they do not use Xtream detail endpoints.
- TMDB enrichment is optional and must not prevent a user from browsing, searching, or playing provider content. Enrichment failures must be retryable and visible as metadata failures, not playback failures.

Enabling TMDB must not scan the entire catalog immediately. TMDB details are fetched on demand for supported detail views and cached locally. If the TMDB Trending dashboard rail is enabled, the app may fetch the weekly trending list and match it against the local catalog. Disabling TMDB stops new enrichment requests while preserving the cache until the user clears it.

**FR-10. State persistence**

Favorites, recently viewed items, playback positions, dashboard preferences, theme, and player preferences must survive app restarts.

### 8.3 Playback

**FR-11. Engine support**

The product must support the currently active engines: ArtPlayer, HTML5, Embedded MPV, external MPV, and VLC, subject to runtime availability.

**FR-12. Engine availability**

The UI must show whether an engine is available before the user selects it. Missing optional external players must not prevent the app from launching.

**FR-13. Shared controls**

Supported engines should expose a consistent control model for play/pause, seek, volume, speed, aspect ratio, tracks, subtitles, fullscreen, screenshots, and engine switching.

**FR-14. Playback recovery**

The app must provide retry, engine switch, header correction where supported, and external-player fallback where applicable.

**FR-15. Series continuity**

For series, the app must remember the current episode and position, provide previous/next episode navigation, and expose an Up Next path when the next episode is known.

**FR-16. Playback diagnostics**

Diagnostics must distinguish network/URL errors, manifest errors, unsupported codecs or containers, missing runtime dependencies, and provider-side failures.

### 8.4 Browser and YouTube workspaces

**FR-17. Browser workspace**

Users may open HTTP(S) pages in the Electron browser workspace without giving those pages access to Node.js or the application’s privileged APIs.

**FR-18. YouTube workspace**

The YouTube workspace may support ad filtering, SponsorBlock, Google sign-in navigation, fullscreen, and mini-player behavior within its explicitly defined security boundary.

**FR-19. Navigation safety**

Unsupported protocols, unsafe navigation, and uncontrolled window creation must be rejected or routed through the system browser according to an explicit policy.

### 8.5 Credentials and privacy

**FR-20. Secret storage**

Provider passwords, API keys, and access tokens must not be stored as ordinary plaintext application data in the long-term product design. The preferred implementation is macOS Keychain-backed storage with database references.

**FR-21. Redaction**

Credentials must be redacted from logs, debug events, trace payloads, error messages, crash reports, and copied diagnostic summaries.

**FR-22. Explicit export**

Credential export, when intentionally requested by the user, must be clearly labeled as sensitive, require an explicit action, and warn that the resulting file contains credentials.

**FR-23. IPC validation**

Every privileged IPC handler must validate sender ownership, argument shape, URL/protocol constraints, and filesystem boundaries before performing work.

## 9. Non-functional requirements

### Performance

- The renderer must remain responsive during imports, refreshes, database migrations, metadata enrichment, and credential testing.
- Search should return the first usable result set within 500 ms for a typical local catalog and within 2 seconds for a large catalog under normal hardware conditions.
- Metadata status on the Sources page should use aggregate database counts rather than loading every catalog row solely to render the page.
- Provider detail requests must run outside the renderer’s blocking path, use bounded concurrency and request pacing, and process only one provider source at a time.
- Metadata indexing must persist progress in batches so database writes and UI updates do not occur once per item.
- App launch should show the main shell before optional enrichment or diagnostics complete.
- Playback start time should be measured separately for each engine and provider class.

### Reliability

- A failed refresh must preserve the last known good catalog.
- App restart must not lose favorites, positions, source configuration, or settings.
- Native Embedded MPV failures must degrade to another available engine or a clear diagnostic state.
- Cancellation and teardown must not leave orphaned workers, processes, sessions, or IPC listeners.

### Security

- Main renderer: `contextIsolation: true`, `nodeIntegration: false`, sandbox enabled.
- Browser views: least privilege, explicit protocol allowlists, controlled navigation, and denied uncontrolled windows.
- File writes: user-authorized paths only, with one-time authorization where possible.
- Sensitive data: redacted by default and stored in the system credential store where feasible.

### Accessibility and localization

- Keyboard navigation must work for browsing, search, playback controls, dialogs, and settings.
- Focus must be visible and restored after dialogs or player transitions.
- User-facing strings must remain localizable.
- Layouts must support the existing light, dark, and system themes.

### Compatibility

- Supported runtime: macOS Apple Silicon arm64.
- Clear H.264/AAC and common MP4/HLS/DASH streams are the baseline playback target.
- HEVC, unusual containers, audio codecs, and DRM-protected streams must be reported according to engine capability rather than promised universally.

## 10. Quality strategy

The release gate must include:

1. Unit tests for parsing, normalization, credential handling, lifecycle races, search planning, and playback classification.
2. Integration tests for database initialization, migrations, imports, refresh failure preservation, favorites, and playback positions.
3. Packaged-app smoke tests for startup, source import, catalog browsing, direct play, engine switching, and shutdown cleanup.
4. Fixture-based stream tests for common HLS, DASH, MP4, live, VOD, subtitle, header, and failure scenarios.
5. Security checks for IPC sender validation, browser navigation, file writes, credential redaction, and secret persistence.
6. A signed and notarized release validation path when distributing outside local development.

The repository should expose one documented command for the full test suite and should not rely on ad-hoc direct execution of individual TypeScript test files.

## 11. Success metrics

### North-star metric

**Successful first playback rate:** percentage of newly added sources for which the user reaches a playing stream within 10 minutes of completing source setup.

### Supporting metrics

- Source import completion rate.
- Refresh success rate and percentage of refreshes preserving the last known good catalog.
- Median search-to-play time.
- Playback start success by engine and source type.
- Playback recovery success after an initial failure.
- Crash-free sessions.
- Percentage of sessions with restored playback position.
- Credential redaction test coverage and zero known credential leaks in diagnostics.
- Time required to produce a useful playback diagnostic.

Metrics should be collected locally or in opt-in diagnostics unless the product later introduces an explicit privacy-reviewed telemetry policy.

## 12. Release plan

### Phase 1: Core reliability

- Establish the canonical test command and CI execution.
- Fix test-runner path alias resolution.
- Add import, refresh, catalog, playback, and resume smoke tests.
- Verify worker cancellation and teardown.
- Define engine-specific playback fixtures and failure classifications.

### Phase 2: Privacy and security hardening

- Migrate credentials and API keys toward macOS Keychain storage.
- Audit every IPC handler and browser-view navigation path.
- Expand redaction tests to URLs, headers, errors, trace payloads, and exported diagnostics.
- Review the YouTube security exception and minimize its privileges.

### Phase 3: Maintainability and performance

- Split the preload bridge into domain namespaces.
- Split database operations and browser management into bounded services.
- Add performance budgets for import, search, startup, and playback start.
- Remove or resolve persistent lint, CommonJS, and deprecated native API warnings where practical.

### Phase 4: Distribution readiness

- Developer ID signing and notarization.
- Versioned migration and rollback strategy.
- Crash reporting and support bundle with guaranteed redaction.
- Auto-update policy and release notes.

## 13. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Provider APIs and stream URLs are inconsistent | Import and playback failures | Normalize at provider boundaries; classify errors; preserve last known good data |
| Multiple playback engines diverge | Confusing controls and bugs | Shared playback contract plus engine-specific conformance tests |
| Credentials are exposed in local data or logs | User privacy and trust failure | Keychain storage, redaction, security tests, explicit sensitive export warnings |
| Native MPV runtime changes with macOS | Packaged playback regression | Vendored runtime verification, startup diagnostics, packaged smoke tests |
| Large catalogs make the UI feel slow | Poor retention and perceived instability | Worker-backed operations, indexed search, pagination, performance budgets |
| Feature breadth outpaces verification | Regressions and slow releases | Freeze new engines/providers until core journey gates pass |
| Browser workspace expands security surface | Privilege escalation risk | Least-privilege WebContentsView configuration and navigation allowlists |

## 14. Open decisions

1. Is ARM-Nator intended for private/local use only, or will it be distributed publicly?
2. Should credentials be migrated automatically to Keychain on first launch after the change?
3. Should user telemetry be entirely opt-in, or should the app provide only local diagnostic bundles?
4. Which engines are officially supported for release, and which are best-effort integrations?
5. What is the minimum supported macOS version for the next public release?
6. Should the current bulk credential tester remain a first-class product feature or become an advanced tool behind an explicit warning?
7. What is the required behavior when a provider returns a partial catalog during refresh?

## 15. Definition of done for the next release

The next release is ready when:

- A new user can add a supported source and reach first playback through the documented flow.
- A returning user can find and resume previously watched content.
- Imports and refreshes do not block the UI or destroy the last known good catalog.
- Playback failures produce an actionable diagnostic and at least one recovery path when technically possible.
- The full automated test command passes in CI.
- Packaged macOS arm64 smoke tests pass with the embedded runtime present.
- Credentials are not exposed in logs, diagnostics, crash bundles, or ordinary persisted application data.
- The release is signed and notarized if public distribution is a product requirement.
