# Product goal and release readiness

ARM-Nator is a dependable desktop IPTV player for everyday viewing. Its advertised features must work consistently, and failures must be understandable and recoverable. Prioritise data loss, unexpected exits, blocked viewing, and misleading failure states before expanding the feature set.

Provider availability and universal stream compatibility cannot be guaranteed. State supported inputs, playback limitations, and platform requirements accurately in the app and release notes.

## Release acceptance

Run these checks on the actual release candidate on the supported Apple Silicon/macOS target. Record the app version, macOS version, input/provider type, playback engine, steps, result, and remaining issue for each applicable journey. Keep credentials out of shared evidence.

| Journey | Required result |
| --- | --- |
| Add a playlist or provider | A supported input connects and becomes browsable. Invalid input, rejected credentials, an unavailable host, and a timeout produce understandable errors and a usable correction/retry path. |
| Browse and discover | Channels load; search finds known entries; available programme information is shown. Missing programme data does not prevent browsing or playback. |
| Watch and control | Representative supported live and recorded fixtures start and advance. Pause/resume, volume, seeking where supported, channel switching, and Close remain responsive. |
| Keep user data | Playlists, favourites, and settings survive a full quit/relaunch. Upgrade a copy of a populated prior-version profile and verify the same data survives. A failed refresh must preserve previously saved data. |
| Recover from failure | Interrupt an API request and break an active stream. The app stays open, preserves user data, ends loading in a useful state, and allows retry, another channel, or closing playback. Check terminal account/DRM/resource stops and the documented six-action rolling playback recovery limit in the [implementation notes](player-reliability/IMPLEMENTATION.md). |
| Repeated everyday use | Repeated channel changes and player open/close cycles leave no orphan sessions, connections, or player processes. Investigate sustained memory growth and verify the native-memory acceptance check. |
| Explain limitations | Advertised features match the tested release scope. Provider rejection, unsupported media, and app failures are distinguished where evidence permits; unknown failures do not claim a cause. |

Automated checks supplement these journeys. Run `pnpm test` and `pnpm test:angular`, plus the appropriate build/package and native checks for the changed paths. Record exact commands and exit statuses. Passing unit tests alone does not establish packaged-app or provider compatibility.

## Release decision

Unresolved data loss, unexpected exits, unusable core journeys, or unbounded recovery block a dependable-player release. Mark each journey passed, failed, or unverified; missing evidence is unverified. Describe remaining provider and format limitations in the release notes. Resolve an open acceptance check or explicitly revise the release scope with supporting evidence before claiming it passed.

See [player reliability implementation](player-reliability/IMPLEMENTATION.md) for playback evidence and its open native-memory acceptance check.

## Assessment started 2026-10-21

- `node tools/testing/run-node-tests.mjs`: exit 0; 633 tests passed.
- `node tools/testing/run-angular-tests.mjs`: exit 0; 53 suites and 709 tests passed.
- The initial `pnpm` commands failed with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`. `pnpm install --frozen-lockfile` completed with exit 0, without changing the lockfile, and repaired the local install state. Subsequent `pnpm test` and `pnpm test:angular` both completed with exit 0 (633 Node tests; 53 Angular suites / 709 tests).
- Native comparison using the packaged app's FFmpeg and native addons completed with exit 0: 16 functional runs and two six-second progress checks passed across KSPlayer and MPV. H.264/HEVC startup and seeking, loopback VOD HLS, and subtitle track selection were exercised. Report: `tmp/player-backend-comparison/results/readiness-2026-10-21.json`. This runs packaged addons in a development Electron harness, not the packaged app's complete UI. Native subtitle pixel compositing and authenticated/live provider playback remain unverified. MPV emitted CoreAudio input-channel-layout errors during these runs; media progress passed, but audible output was not verified.
- Packaged-app viewing journeys, current restart/upgrade checks, and the native-memory gate have not been reverified in this assessment. This is not a release sign-off.

No release candidate or macOS test environment was recorded for manual journeys in this assessment. Complete those fields and attach steps/results when executing the checks.

| Journey | Current status | Evidence still needed |
| --- | --- | --- |
| Add a playlist or provider | Unverified | Candidate setup and rejection/timeout checks |
| Browse and discover | Unverified | Candidate browse/search/programme checks |
| Watch and control | Unverified | Candidate live/recorded playback and controls |
| Keep user data | Unverified | Candidate quit/relaunch and prior-profile upgrade |
| Recover from failure | Unverified | Candidate API/stream interruption and bounded recovery |
| Repeated everyday use | Unverified | Candidate soak and native-memory acceptance |
| Explain limitations | Unverified | Candidate UI and release-note claims compared with results |

## Observed playback failure and targeted repair

On 2026-10-21, the user demonstrated `JOR| A ONE HD` failing in the packaged app. The configured provider host returned HTTP 401; a provider-advertised alternate host failed DNS lookup with `ENOTFOUND`. Retrying the current source repeated the DNS failure. These observations establish failed attempts, not a universal explanation for other channels or providers.

The preparation API previously reduced the nested DNS error to `unknown-error: fetch failed`. The source change preserves recognised DNS codes across IPC and supplies a safe explanation to the visible playback banner. HTTP rejection statuses remain intact. This repairs error reporting; playback for the affected provider has not been restored or verified.

- The DNS API regression fails against the original implementation and passes with the fix. A player-state regression checks the visible explanation and confirms that it does not recommend an external decoder for a DNS failure.
- The IndexedDB regression now checks saved favourite and recent-item metadata after reopening an existing database. This covers the current schema, not a schema-version migration, SQLite migration, or settings persistence.
- After these changes, `pnpm test` passed 635 tests and `pnpm test:angular` passed 53 suites / 709 tests (both exit 0).
- Production build and packaging completed with exit 0. The separate test app is `tmp/readiness-package/mac-arm64/ARM-Nator.app`; the previous package was not overwritten. Its backend and frontend bundles contain the DNS fix, and `codesign --verify --deep --strict` passes. The new app has not yet been used to reverify this provider's playback.

## Approved Auto recovery policy

Auto now chooses known source alternatives from the failure evidence, rather than leaving host and format choices entirely to manual recovery. DNS failures use an untried known host or stop; source rejection/missing media can use provider-supported host and format alternatives after a supported renewal. Duplicate source URLs and DNS-failed hosts are excluded. A format change preserves a usable alternate host only when matching HLS/TS metadata identifies the same stream. Existing decoder fallback, three-attempt episode limits, six-action rolling limits, deadlines, cancellation, and owned-session cleanup remain enforced.

Initial media preparation now preserves `Retry-After` through inspection, IPC, recovery, and the final diagnostic. HTTP 429 takes precedence over a generic rejection label; it waits within the recovery budget or stops if the instructed delay exceeds that budget.

Regression checks first reproduced repeated DNS requests, unused host/format alternatives, lost retry delays, and a temporary-DNS replay exception. The corrected source passes 647 Node tests and 53 Angular suites / 709 tests. Independent review's DNS replay finding was corrected and rechecked. The scenarios replay captured failure classes; they are not proof that every provider recovers.

The first packaged policy build launched with the existing saved library. During live inspection the session moved between providers, so the original `JOR| A ONE HD` case was not conclusively reverified. A real provider session logged media HTTP 200 and native `playing`, followed by release; that does not establish that this new recovery policy caused a recovery.

The final reviewed package is `tmp/auto-policy-final/mac-arm64/ARM-Nator.app`. Production packaging completed with exit 0, `codesign --verify --deep --strict` passed, and inspection of its archived frontend/backend confirmed source selection and retry-delay propagation are included. It is separate from the active test session and the prior packages.


## v0.33.0 scoped release — 2026-10-22

Candidate: the main-branch source tagged `v0.33.0`, with package version `0.33.0`.
Local environment: macOS 27.0.1 (26A434), Apple Silicon arm64, Node 26.11.1, pnpm 12.11.2.
This is a scoped feature release of source playback evidence and metadata inspection. It does not claim that the previously unverified dependable-player acceptance journeys have passed.

- `pnpm test`: exit 0, 759 Node tests passed, including original-provider metadata preservation.
- `pnpm test:angular`: the initial run exposed a stale row-action test selecting removed inline buttons. The test now opens the real overflow menu and checks refresh/edit/remove events; a new right-click test verifies the same actions without navigation. The targeted source-playback run passes 7 suites / 13 tests. After refreshing the local pnpm install state with `pnpm install --frozen-lockfile` (exit 0, lockfile unchanged), the full `pnpm test:angular` rerun passed 61 suites / 725 tests with exit 0.
- `env NX_DAEMON=false ./node_modules/.bin/nx run-many -t build --projects=desktop-ui,electron-backend --configuration=production --excludeTaskDependencies --skip-nx-cache --outputStyle=static`: exit 0 for both production builds. CI performs native runtime builds and packaging from the immutable tag.
- Development Electron UI, Xtream input: inspected the populated Sources page, expanded category evidence, overflow menu and right-click menu. Both menus retained refresh, edit, and remove; opening evidence did not navigate.
- Development Electron UI, Xtream movie details: Provider restored the original Arabic synopsis, supplied cast and rating; TMDB restored enriched text and cast portraits. The dialog switched sources with the page. Searched `codec`: TMDB fields had no match; Provider returned the original audio/video objects, which expanded into formatted JSON. Media info showed 1920 × 800, 23.976 fps and 48,000 Hz from the provider. The movie TMDB link resolved to the movie URL path.
- The new metadata UI also compiles for series; a separate native series walkthrough was not performed.
- Full packaged-app launch/upgrade/restart, new-provider error paths, playback controls/failure recovery, and repeated-use/native-memory acceptance remain unverified for this candidate. Existing earlier evidence is retained above; it is not new candidate evidence.
- Release notes explicitly state these limitations and distinguish sampled playback evidence from a guarantee that an entire source works. No credentials are included in shared evidence.

## v0.34.0 scoped search release — 2026-10-23

Candidate: package version `0.34.0`, intended tag `v0.34.0`.
Local environment: macOS 27.0.1 (26A434), Apple Silicon arm64, Node 26.11.1, pnpm 12.11.2.
This release covers Global Search grouping, scope, display years, and Multi language labels. It does not claim completion of the broader dependable-player acceptance journeys.

- After the version bump, the first `pnpm test` invocation stopped before running tests with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`. `pnpm install --frozen-lockfile` completed with exit 0; the lockfile remained unchanged.
- The next `pnpm test` run passed 771 of 772 tests. The existing `recovery starts a new budget after an exhausted window` test failed its 80 ms timer assertion. Its isolated rerun passed with exit 0. `ARM_NATOR_NODE_TEST_CONCURRENCY=1 pnpm test` then passed all 772 tests with exit 0. No playback implementation or test was changed to obtain that result.
- After removing the redundant Global Search scope sentence, `pnpm test:angular` passed all 63 suites / 732 tests with exit 0.
- `pnpm package` completed with exit 0, including production UI/backend builds and native packaging. The packaged app reports version `0.34.0`; `codesign --verify --deep --strict` passes. Archive inspection confirms Multi rendering and removal of the scope helper sentence; the packaged database worker contains category-name projections.
- The preceding local feature candidate, still labelled `0.33.0` before this release version bump, was installed over a populated existing app and reopened successfully. Global Search showed `Leto 2018` as 2018, and Sources showed Multi for an untagged `What Jennifer Did (2024)` entry whose indexed category contains MULTI. Searches and saved library data remained available after the quit/relaunch. These are targeted observations of the search implementation; they are not a complete profile upgrade acceptance test or a fresh UI walkthrough of the version-bumped package.
- Regression coverage includes conservative grouping, source preference/artwork preservation, one workspace search field, year display/sort without changing work identity, MULTI tag/category precedence, and category-name propagation through title-index, FTS, and fallback SQLite queries.
- New-provider setup/error paths, live and recorded playback controls/recovery, a full prior-profile upgrade, repeated-use/native-memory acceptance, and broad media/provider compatibility remain unverified for this candidate. The release notes retain these limitations. Portal category fallback depends on a category name being supplied in the search response.
- `graphify update .` completed after the final code change. `git diff --check` is clean. No credentials are included in this evidence or release notes.
