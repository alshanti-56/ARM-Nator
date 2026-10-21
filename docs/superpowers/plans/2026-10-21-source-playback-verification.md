# Source Playback Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Sources screen with saved, honest playback evidence for Live, Movies, and Series without interrupting viewing.

**Architecture:** Pure shared evidence policy, a separate SQLite repository, provider samplers, an isolated silent player, and one playback-resource coordinator. The desktop app composes these services; playlist UI consumes a small injected facade. Normal viewing produces evidence through the same reducer.

**Tech Stack:** Existing Angular/Material/NgRx, Electron, TypeScript, SQLite/Drizzle, HTML media with existing HLS/MPEG-TS helpers, Node tests and Jest. Keep the versions pinned in package.json; add no dependencies.

**Spec:** [Approved design](../specs/2026-10-21-source-playback-verification-design.md), including its linked approved mockup. The user's “continue” approved that written design. This plan is pending review and execution-method selection.

## Global Constraints

- A successful sample proves only that item worked at that time with the recorded engine. It never guarantees the whole library works.
- Every source has independent `live`, `movies`, and `series` evidence. Keep classification separate from activity (`queued`, `checking`, `deferred`) and freshness (`fresh`, `stale`).
- Evidence becomes stale after 24 hours; retain its result with a Stale label and timestamp.
- Try at most three distinct items per category. Stop immediately after the first qualified success.
- Require six seconds of confirmed forward playback and video-frame evidence, or positively identified audio-only playback with confirmed progress. Metadata/signature detection is insufficient.
- Catalogue/sample discovery: 10 seconds per category; each sample: 20 seconds total; category: 70 seconds overall.
- After two seconds without cleanup acknowledgement, suspend background checks until closure is confirmed. Never start an overlapping transport.
- Desktop-only automatic checks start after ten seconds of genuine playback idle time. Paused/loading/native/external/YouTube/recovery sessions count as occupied.
- Timeout/unavailable-provider cooldown starts at 15 minutes, doubles per consecutive inconclusive check, and caps at six hours. Honor a longer provider Retry-After.
- Up to 20 observations per source/category, removing entries older than 30 days. Instability requires at least three conclusive observations and two playable/failed switches within seven days.
- Preserve the existing shell, scoped search, provider filters, row navigation/actions, drag ordering, busy states, theme tokens, and compact sidebar rows. Bulk Test retains its existing meaning.
- Never persist resolved media URLs, signed links, auth headers, tokens, passwords, or unredacted transport errors in this feature's records.
- Background checks must not change volume, active playlist, viewing history, resume state, foreground recovery, or external apps.
- Browser-only installations show the feature as unavailable; do not use localStorage as an alternative evidence database.
- Run `graphify query "<question>"` before the first source search/read; read source locations surfaced by the graph or earlier reads. Run `graphify update .` after application-code changes. Apply this rule in every code-exploring worker prompt.
- Preserve all pre-existing dirty files. Several automatic-playback and workspace-player changes are uncommitted; do not reset, replace, or include them indiscriminately in feature commits.

## Review Focus

- A source is renamed, edited, deleted, or reimported while a slow check finishes: reject stale identity writes; retain evidence only for a rename (Tasks 2, 6).
- A user closes/dismisses an external player bar without ending its process: checks must remain blocked until lifetime is known (Task 4).
- Accelerated playback, a seek, or a stale frame counter makes the media clock jump six seconds immediately: never verify without sustained current-generation evidence (Tasks 1, 5).
- A provider ignores cancellation and returns a prepared session late: release it, withhold the lease, and prevent subsequent connections until cleanup is acknowledged (Tasks 4–6).
- A save fails or an old request completes after a newer viewing success: do not publish false “saved” state or overwrite newer evidence (Tasks 2, 3, 10).

## File map and dependency direction

All paths below are relative to the repository root. Proposed files do not exist yet. Tasks list the exact files each change owns. Shared DTOs/policy live in `libs/shared/interfaces`; Angular state/repository and UI-facing tokens live in `libs/services`; playback ownership and silent driver live in `libs/player`; provider adapters live in their data-access libraries; composition/scheduling live in `apps/desktop-ui`. Do not make services depend on player UI, or database code depend on Angular.

| Area | Proposed units |
| --- | --- |
| Evidence contracts and pure policy | `source-playback-evidence.ts`, `source-playback-policy.ts`, `source-playback-confirmation.ts` in `libs/shared/interfaces/src/lib/` |
| Database | Additive evidence migration, operations, worker/IPC dispatch and renderer repository |
| UI state | `libs/services/src/lib/source-playback/` repository, store, facade token |
| Presentation | New `source-playback-details/` component beside recent-playlists, existing playlist-item and Sources filter components |
| Ownership | Pure `libs/player/core/src/lib/playback-resource-coordinator.ts`, Angular service in player UI |
| Silent player | `libs/player/ui/src/lib/source-playback/` transport driver, probe service, and invisible host |
| Samplers | `source-playback-sampler.service.ts` in each provider's data-access library |
| App composition | `apps/desktop-ui/src/app/services/source-playback/` check service, scheduler, viewing observer |

Read the existing source before each task; line numbers are unstable because the workspace already has playback edits. Keep individual units focused; do not grow `PlayerService` or the existing playlist component into a new subsystem.

## Verification commands and baseline

At execution start use `superpowers:using-git-worktrees` to choose/reuse safe isolation. Record `git status --short`, the base commit, and relevant baseline test results. Any isolated checkout must include the current approved docs and required uncommitted playback changes through a deliberate snapshot/patch; the default branch alone is not an equivalent starting point. Do not commit unrelated user work merely to create a checkout.

Use these command forms from the repository root:

- **Node focused:** `TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx --test <exact .spec.ts files>`; the existing `pnpm test` runner discovers all `node:test` suites and does not accept file filters.
- **Angular focused:** `pnpm exec jest --config <config> --runInBand --runTestsByPath <exact .spec.ts files>`.
- **Build:** `pnpm exec nx run desktop-ui:build --configuration=development` and `pnpm exec nx run electron-backend:build`. The backend has no named development configuration and this target includes its worker/native build prerequisites.
- **Changed-source lint:** `pnpm exec eslint <explicit changed .ts/.html files>`; use actual project's ignore rules for non-lintable file types.

Task tests below name additional test fixture helpers; define those helpers in the owning `.spec.ts`, not in production exports. Every task follows red → implementation → green. Commit only its owned changes after inspecting `git diff`/`git diff --cached`; if a file already contains user changes, stage only this task's hunks. Commit descriptions below are suggested messages, not authorization to stage unrelated work.

---

### Task 1: Evidence types, classification, and sustained playback confirmation

**Files:**
- Create: `libs/shared/interfaces/src/lib/source-playback-evidence.ts`
- Create: `libs/shared/interfaces/src/lib/source-playback-policy.ts`
- Create: `libs/shared/interfaces/src/lib/source-playback-policy.spec.ts`
- Create: `libs/shared/interfaces/src/lib/source-playback-confirmation.ts`
- Create: `libs/shared/interfaces/src/lib/source-playback-confirmation.spec.ts`
- Modify: `libs/shared/interfaces/src/index.ts`

**Interfaces:**
- Produce `SourcePlaybackCategory = 'live' | 'movies' | 'series'`, `SourcePlaybackResult = 'untested' | 'verified' | 'mixed' | 'failed' | 'unstable'`, and `SourceEvidenceKey = { sourceId: string; revision: string; category: SourcePlaybackCategory }`. Export `sourceEvidenceKey(key: SourceEvidenceKey): string` using deterministic JSON tuple serialization, not delimiter concatenation.
- Produce `SourceSampleEvidence = { itemId: string; title: string; outcome: 'played' | 'failed' | 'inconclusive' | 'cancelled'; reason: SourcePlaybackReason | null; elapsedMs: number; engine: string; audioOnly: boolean }`. Define `SourcePlaybackReason` as a closed enum covering provider rejection, unavailable item, startup timeout, stall, unsupported media, local engine unavailable, local access, offline, network unknown, provider busy/throttled, no samples, cancelled, teardown pending, save failure, and unsupported category.
- Produce `SourcePlaybackObservation = { checkId: string; key: SourceEvidenceKey; origin: 'background' | 'manual' | 'viewing'; startedAt: number; completedAt: number; successfulAt: number | null; result: 'verified' | 'mixed' | 'failed'; samples: readonly SourceSampleEvidence[] }`.
- Produce `SourceCheckAttempt = { checkId: string; key: SourceEvidenceKey; origin: 'background' | 'manual' | 'viewing'; startedAt: number; completedAt: number; samples: readonly SourceSampleEvidence[]; reason: SourcePlaybackReason | null }` for nonconclusive updates. It never replaces a conclusive observation.
- Produce `SourcePlaybackSummary = { key: SourceEvidenceKey; result: SourcePlaybackResult; latest: SourcePlaybackObservation | null; lastSuccessfulAt: number | null; stale: boolean; latestAttempt: SourceCheckAttempt | null }` and `SourcePlaybackFilter = { category: SourcePlaybackCategory | 'all'; result: SourcePlaybackResult | 'any' | 'working-recently' }`.
- `classifySourceCheck(attempt: SourceCheckAttempt, selectedCount: number, exhausted: boolean): SourcePlaybackObservation | null`.
- `summarizeSourceEvidence(key: SourceEvidenceKey, observations: readonly SourcePlaybackObservation[], latestAttempt: SourceCheckAttempt | null, now: number, historicalSuccessAt?: number | null): SourcePlaybackSummary`; `matchesSourcePlaybackFilter(summaries: readonly SourcePlaybackSummary[], filter: SourcePlaybackFilter): boolean`. Pass a deduplicated union of retained history and separately persisted latest observation; the historical-success argument preserves a success older than retained history.
- Export `SourceConfirmationInput = { generation: string; atMs: number; positionSeconds: number; playing: boolean; stalled: boolean; seeking: boolean; presentedFrames?: number; frameReady?: boolean; audioOnly?: boolean; audioReady?: boolean }`; `SourcePlaybackConfirmation.observe(input: SourceConfirmationInput): boolean`; `reset(): void`.

- [ ] **Step 1:** Add failing tests and fixture builders for complete/partial checks, latest result precedence, Mixed order, 24-hour boundary, seven-day instability, 20-entry retention ordering, and category/working filters. Add confirmation tests with exact assertions:
  ```ts
  assert.equal(confirmAt({ wallMs: 5_999, mediaSeconds: 6, frames: 120 }), false);
  assert.equal(confirmAt({ wallMs: 6_000, mediaSeconds: 6, frames: 120 }), true);
  assert.equal(confirmAt({ wallMs: 6_000, mediaSeconds: 6, frames: 0 }), false);
  assert.equal(summaryAt(lastSuccessAt + 86_400_000).stale, true);
  assert.equal(classify(partialFailureAndCancellation), null);
  ```
  `confirmAt` feeds observations every 250ms from zero through the supplied final wall/media/frame values. Require both six wall-clock seconds and six media seconds, current-generation frame evidence, finite/nonnegative values, and continued progress (a gap exceeding three seconds resets the window). Reset after stall/seek/generation change. Positively identified audio-only content requires `audioReady`, not just zero video dimensions. A separate jump test supplies only an initial and immediate six-second media jump and must fail.
- [ ] **Step 2:** Run Node focused on the two new `.spec.ts` files; expect missing exports/implementation failures.
- [ ] **Step 3:** Implement the types and pure functions. Centralize all design timing/history constants in `SOURCE_PLAYBACK_POLICY`; injected `now` values govern tests. A check containing inconclusive attempts cannot conclude Failed. Instability ignores incomplete attempts and coalesces viewing updates by check ID.
- [ ] **Step 4:** Run the same command; expect zero failed tests, including accelerated clock, counter reset, out-of-order samples, and success-after-inconclusive cases.
- [ ] **Step 5:** Inspect and commit owned files: `feat: define source playback evidence policy`.

### Task 2: Atomic evidence persistence, source revision, and typed IPC

**Files:**
- Create: `libs/database/src/lib/source-playback-migration.ts`
- Modify: `libs/database/src/lib/schema.ts`, `libs/database/src/lib/connection.ts`
- Create: `apps/electron-backend/src/app/database/operations/source-playback.operations.ts`
- Create: `apps/electron-backend/src/app/database/operations/source-playback.operations.spec.ts`
- Create: `apps/electron-backend/src/app/events/database/source-playback-ipc.spec.ts`
- Modify: Existing database initialization, app-playlist lifecycle, worker dispatch, and preload bridge listed in the database integration notes below.
- Modify: `libs/shared/interfaces/src/lib/ipc-commands.ts`, `libs/shared/interfaces/src/lib/electron-api-extended.interface.ts`
- Create: `libs/services/src/lib/source-playback/source-playback-repository.service.ts`
- Create: `libs/services/src/lib/source-playback/source-playback-repository.service.spec.ts`

**Interfaces:**
- Consume Task 1's DTOs.
- Produce `SourceAccountSnapshot = { checkedAt: number; expiresAt: number | null; expiryKind: 'date' | 'none' | 'unknown'; activeConnections: number | null; maxConnections: number | null }` in the shared evidence file.
- Produce `SourceEvidenceSnapshot = { sourceId: string; revision: string; observations: readonly SourcePlaybackObservation[]; latest: readonly SourcePlaybackObservation[]; lastSuccessfulAt: Partial<Record<SourcePlaybackCategory, number>>; attempts: readonly SourceCheckAttempt[]; account: SourceAccountSnapshot | null; cursor: Partial<Record<SourcePlaybackCategory, string>>; nextEligibleAt: Partial<Record<SourcePlaybackCategory, number>>; inconclusiveCounts: Partial<Record<SourcePlaybackCategory, number>> }`.
- Repository methods: `read(sourceIds: readonly string[]): Promise<readonly SourceEvidenceSnapshot[]>`; `write(input: { observation?: SourcePlaybackObservation; attempt: SourceCheckAttempt; cursor?: string; nextEligibleAt?: number; inconclusiveCount?: number }): Promise<'saved' | 'obsolete'>`; `writeAccount(sourceId: string, revision: string, account: SourceAccountSnapshot): Promise<'saved' | 'obsolete'>`. Corresponding bridge methods are `dbGetSourcePlaybackEvidence`, `dbSaveSourcePlaybackEvidence`, `dbSaveSourcePlaybackAccount`, with shared serializable DTOs and validated main-process arguments.

- [ ] **Step 1:** Add failing transaction/migration tests: fresh/old database, idempotent initialization, 21 writes retain 20, entries older than 30 days removed, one read for six sources, update same check ID, newer completion not overwritten by an older completion, and no credential/URL fields accepted. Rename retains random revision; endpoint/credentials/device/header change replaces it; delete/reimport rejects old writes. A failed transaction changes neither summary nor history.
- [ ] **Step 2:** Run Node focused on the new operation, source-playback-lifecycle and repository tests; expect missing tables/bridge methods.
- [ ] **Step 3:** Implement additive `source_playback_sources` (revision), `source_playback_categories` (latest observation, last success, latest inconclusive note, cursor/backoff), `source_playback_observations` (bounded history), and `source_playback_accounts` tables. Seed revision rows for existing sources during migration. Generate an opaque random revision inside the same source-write transaction; compare only identity-affecting fields, excluding volatile session tokens and labels. Prune history without erasing the separately stored latest result or last success; derive display state with Task 1. Upsert observations by `(sourceId, revision, category, checkId)`, enforce safe DTO size/length limits, sanitize titles/reason codes, reject invalid enum/timestamp/elapsed inputs, and clean evidence on all source-delete/reset paths. Update worker, IPC and preload together; never rely only on renderer cleanup.
- [ ] **Step 4:** Run focused tests and the new `apps/electron-backend/src/app/events/database/source-playback-ipc.spec.ts`, which exercises main handler→worker dispatch and bridge DTO validation for each new operation. Reopen the test database and assert evidence survives. Repository errors reject; callers cannot mistake failure for an empty successful result.
- [ ] **Step 5:** Commit owned hunks: `feat: persist source playback evidence and revisions`.

### Task 3: Native Sources presentation, filters, and evidence details

**Files:**
- Create: `libs/services/src/lib/source-playback/source-playback-facade.token.ts`, `source-playback-store.service.ts`, `source-playback-store.service.spec.ts`
- Modify: `libs/services/src/index.ts`
- Create: `libs/providers/shared/playlist-ui/src/lib/recent-playlists/source-playback-details/source-playback-details.component.ts`, `.html`, `.scss`, `.spec.ts`
- Modify: `libs/providers/shared/playlist-ui/src/lib/recent-playlists/playlist-item/playlist-item.component.ts`, `.html`, `.scss`
- Modify: `libs/providers/shared/playlist-ui/src/lib/recent-playlists/recent-playlists.component.ts`, `.html`
- Modify: `libs/workspace/shell/feature/src/lib/workspace-sources-filters-panel/workspace-sources-filters-panel.component.ts`, `.html`, `.scss`
- Modify: `libs/workspace/shell/feature/src/lib/workspace-sources/workspace-sources.component.ts`, `.html`
- Create: `tools/testing/jest.source-playback.config.ts`, `tools/testing/tsconfig.source-playback.json`
- Create: `libs/providers/shared/playlist-ui/src/lib/recent-playlists/source-playback-details/source-playback-row.integration.spec.ts`
- Create: `libs/workspace/shell/feature/src/lib/workspace-sources-filters-panel/source-playback-filters.component.spec.ts`
- Modify: `apps/desktop-ui/src/assets/i18n/en.json`, `tools/testing/run-angular-tests.mjs`

**Interfaces:**
- `SourcePlaybackFacade = { available: Signal<boolean>; activity: Signal<{ state: 'idle' | 'queued' | 'checking' | 'deferred' | 'teardown-pending'; key?: SourceEvidenceKey; reason?: SourcePlaybackReason }>; requestCheck(key: SourceEvidenceKey): Promise<void> }`, supplied through optional `SOURCE_PLAYBACK_FACADE` injection token. No provider/transport imports in presentation.
- Store exposes `summaries: Signal<ReadonlyMap<string, readonly SourcePlaybackSummary[]>>`, `filter: Signal<SourcePlaybackFilter>`, `persistenceFailure: Signal<string | null>`, `load(sourceIds: readonly string[]): Promise<void>`, `setFilter(filter: SourcePlaybackFilter): void`, `refreshSaved(sourceIds: readonly string[]): Promise<void>`. Initial values represent Untested, never sample fixtures.
- Details inputs: `summary`, `account`, `activity`; output `checkAgain: SourceEvidenceKey`. Row inputs add optional source evidence and `expandedCategory`; disclosure/output handling stays independent from row navigation.

- [ ] **Step 1:** Write failing Angular interaction tests proving source body navigates once, disclosure/Enter/Space only expands, badge click chooses category without navigation, refresh/edit/delete still work, sidebar mode remains compact, and expanded controls cannot start drag. Add store tests where a failed read/save acknowledgement leaves prior saved evidence and exposes an error; filters use Task 1 and preserve existing custom order/source search.
- [ ] **Step 2:** Add a dedicated Jest config rooted at the repository with testMatch limited to these new source-playback UI tests, the existing Angular test setup, and a dedicated tsconfig extending `tsconfig.base.json` with Jest/Node types. Run `pnpm exec jest --config tools/testing/jest.source-playback.config.ts --runInBand`; expect assertions about absent results/details to fail. Add that config to the aggregate Angular runner.
- [ ] **Step 3:** Implement the approved mockup with existing theme variables. Extend provider sidebar with Category/Result/Working recently, shared store filtering, three text/icon badges, stale indicator, checked age, and inline details. Use semantic buttons, `aria-expanded`, keyboard focus, safe localization keys under `WORKSPACE.SOURCES.PLAYBACK`, and existing fallback language behavior. Keep the credential Bulk Test link unchanged. Backend unavailable means explanation and disabled check action; fixtures exist only in tests. Wrap category results on narrow rows; maintain existing busy controls and counts.
- [ ] **Step 4:** Run dedicated Jest suite and store Node test; expect zero failures. Build desktop UI. Compare normal/narrow Sources screens with the approved mockup using fake test fixtures through the test harness; ensure fixtures cannot reach a production store.
- [ ] **Step 5:** Commit owned changes: `feat: display source playback evidence in existing Sources UI`.

### Task 4: Exclusive resource ownership and immediate viewing preemption

**Files:**
- Create: `libs/player/core/src/lib/playback-resource-coordinator.ts`, `.spec.ts`; export from `libs/player/core/src/index.ts`
- Create: `libs/player/ui/src/lib/source-playback/playback-resource.service.ts`
- Modify: `libs/player/ui/src/lib/workspace-player/workspace-player-state.service.ts`
- Modify: `apps/desktop-ui/src/app/services/player.service.ts`, `external-playback.service.ts`
- Create: `apps/desktop-ui/src/app/services/source-playback/source-playback-ownership.service.ts`, `.spec.ts`
- Extend: `apps/desktop-ui/src/app/services/player-service-automatic-playback.integration.spec.ts`, `libs/player/ui/src/lib/workspace-player/workspace-player-teardown.spec.ts`

**Interfaces:**
- `PlaybackResourceCoordinator({ now, cleanupTimeoutMs: 2_000 })` exposes `tryAcquireBackground(release: () => Promise<void>): { signal: AbortSignal; release(): Promise<void> } | null`, `beginForeground(): Promise<{ finish(): void }>`, `setOccupied(occupied: boolean): void`, `isBlocked(): boolean`. `finish()` removes the pending-open reservation only; live session occupancy remains independently tracked. One Angular `PlaybackResourceService` owns one coordinator and exports these methods; no per-row instance.
- App ownership service `start(): () => void` observes workspace playback/stopped/automaticPreparing/recovery, YouTube, external session lifetime, and pending opens. Paused or dismissed is not closed. Preserve references while cleanup is pending.

- [ ] **Step 1:** Write failing fake-clock tests asserting no background lease while paused/loading/external unknown; pending foreground blocks lease acquisition before its first await; preemption aborts immediately; second foreground supersedes first; release rejection remains blocking; 2,000ms sets teardown-pending without opening another connection; late cleanup clears only its own owner. Test a dismissed external bar and YouTube replacement specifically.
- [ ] **Step 2:** Run Node focused on coordinator/ownership and existing teardown/automatic-player integration files; new ownership assertions must fail before implementation. Record pre-existing failures separately.
- [ ] **Step 3:** Implement the coordinator and narrow hooks in `PlayerService` entry methods, `WorkspacePlayerStateService.prepareForPlayback`, and YouTube's direct `replaceWithYoutube` transition. Foreground must reserve before preparation or external launch, then revoke and await background cleanup; maintain current transition generations. Use `try/finally` for reservations. Never treat the dock's dismissal as lifetime closure; unknown external lifetime remains occupied. Route pending cleanup into existing `teardownFailure` handling. Avoid nested reservation deadlocks when openResolvedPlayback delegates to another open method.
- [ ] **Step 4:** Run the same tests; expect all feature assertions and existing lifecycle tests to pass. Test stalled cleanup with a resolving promise rather than a timer-only stub so real ordering is proved.
- [ ] **Step 5:** Commit only feature hunks: `feat: arbitrate source checks and foreground playback ownership`.

### Task 5: Isolated silent playback with real decode evidence

**Files:**
- Create: `libs/player/ui/src/lib/source-playback/silent-media-session.ts`, `.spec.ts`
- Create: `libs/player/ui/src/lib/source-playback/source-playback-probe.service.ts`, `.spec.ts`
- Create: `libs/player/ui/src/lib/source-playback/source-playback-probe-host.component.ts`, `.html`, `.scss`
- Modify: `libs/player/ui/src/index.ts`
- Modify: `libs/workspace/shell/feature/src/lib/workspace-shell/workspace-shell.component.ts`, `.html`
- Create: `tools/testing/source-playback-probe.electron.cjs`

**Interfaces:**
- Consume Task 1 confirmation and Task 4 lease. `SilentMediaSession` owns one HTML video element, HLS/MPEG-TS/native driver and event subscriptions: `start(playback: ResolvedPortalPlayback, signal: AbortSignal, observe: (sample: SourceConfirmationInput) => void): Promise<void>`, `close(): Promise<void>`. Export `SourceConfirmationInput` as the named input type from Task 1.
- `SourcePlaybackProbeService.probe(playback: ResolvedPortalPlayback, signal: AbortSignal): Promise<{ outcome: 'played' | 'failed' | 'inconclusive' | 'cancelled'; reason: SourcePlaybackReason | null; elapsedMs: number; engine: 'html5'; audioOnly: boolean }>`; `drain(): Promise<void>` remains pending until all preparation/driver/proxy resources have closed, including late successful preparations.

- [ ] **Step 1:** Write failing tests for metadata-only/no-frame responses, media clock jumps, muted audio-only confirmation, 20-second parent deadline, abort during preparation/startup/playback, late preparation release exactly once, and HLS/MPEG-TS teardown. Spy on volume localStorage, history/resume writes, active source and foreground runtime: none may change.
- [ ] **Step 2:** Run Node focused on the two new specs with injected fake video/transport clocks; expect missing implementation failures.
- [ ] **Step 3:** Build a dedicated silent session around existing source-selection/proxy helpers; do not mount `WebPlayerViewComponent`, `HtmlVideoPlayerComponent`, or `HtmlVideoElementSession`, which carry foreground or volume side effects. Prepare with a unique attempt ID using the existing Electron bridge; pass its `preparedProxy` to the driver rather than opening a duplicate preparation. Keep the retained response until driver teardown finishes. Host video is muted, playsInline, nonfocusable and aria-hidden in a noninteractive offscreen layer; do not use display:none. Read current frames/progress with the existing telemetry helper and injected monotonic clock. Audio-only verification additionally needs an engine decoded-audio signal; if it is unavailable, audio-only checks remain inconclusive. If the environment cannot decode/provide evidence, return inconclusive. No external/native fallback or automatic recovery stack. Teardown: stop/clear media, destroy driver, cancel pending preparation, release prepared session, remove listeners, acknowledge lease.
- [ ] **Step 4:** Run unit tests and `pnpm exec electron tools/testing/source-playback-probe.electron.cjs`. The new harness must serve a deterministic local video fixture and a decodable stream/manifest, run a separate test renderer using the actual silent session bundle, assert qualification after six seconds, and prove a metadata-only fixture never qualifies. Reuse generation/serving patterns from `tools/player-stream-fixtures.mjs` (existing FFmpeg fixture prerequisite); surface a missing fixture dependency explicitly rather than silently skipping this check. Check HTTP connection count returns to zero and foreground state remains unchanged. This real-engine acceptance check is required; jsdom alone cannot prove decoding. If offscreen media never produces evidence, fix the host rather than weakening the success rule.
- [ ] **Step 5:** Commit owned changes: `feat: add isolated silent playback probe`.

### Task 6: First complete milestone — saved Xtream Live checks

**Files:**
- Create: `libs/providers/xtream/data-access/src/lib/source-playback-sampler.service.ts`, `.spec.ts`; export from its `src/index.ts`
- Create: `apps/desktop-ui/src/app/services/source-playback/source-playback-check.service.ts`, `.spec.ts`
- Modify: `apps/desktop-ui/src/app/app.config.ts`
- Modify: `libs/providers/xtream/data-access/src/lib/services/xtream-api.service.ts`
- Create: `apps/desktop-ui/src/app/services/source-playback/source-playback-milestone.integration.spec.ts`
- Extend: Task 2's catalogue sample-read operations and typed bridge, with the concrete paths in the integration notes.

**Interfaces:**
- Shared `SourcePlaybackCandidate = { itemId: string; title: string; category: SourcePlaybackCategory; categoryId: string; episodeId?: string }`; `SourcePlaybackSampler = { select(sourceId: string, category: SourcePlaybackCategory, signal: AbortSignal): Promise<readonly SourcePlaybackCandidate[]>; resolve(sourceId: string, candidate: SourcePlaybackCandidate, signal: AbortSignal): Promise<ResolvedPortalPlayback> }` in the shared evidence contract. Candidate DTOs never contain URLs/headers.
- `XtreamSourcePlaybackSamplerService` implements sampler. Add optional category filtering to existing stream-list request options without changing existing callers. Prefer a DB query limited to three eligible items, rotated using stored cursor/recent-success ID, excluding hidden/unavailable categories. For uncached sources use bounded category-specific API enumeration; do not import a catalogue or set current XtreamStore playlist.
- `SourcePlaybackCheckService` implements Task 3 facade, `requestCheck(key): Promise<void>` and internal `runCheck(key, origin: 'manual' | 'background', signal): Promise<void>`; `available` is desktop runtime/bridge capability. Activity communicates deferral immediately rather than leaving the UI action promise pending until idle. Own queue records, not unresolved UI promises.

- [ ] **Step 1:** Write failing tests for three failed samples, first failure then success stopping at two, one success stopping at one, two available candidates, no candidates, no cached catalogue, hidden categories, source edits/delete mid-attempt, provider sessions ignoring abort, and persistence rejection. Assert source/category selection remains unchanged and Movies/Series stay Untested until supported.
- [ ] **Step 2:** Run Node focused on sampler/check/milestone specs; expect missing service/bridge behavior.
- [ ] **Step 3:** Compose repository, sampler, lease and probe in the app. Acquire lease before provider work, load/validate current revision, use 10s discovery/20s attempt/70s category parent abort budgets, resolve fresh playback per sample using `XtreamApiService`, `XtreamUrlService` and `buildXtreamSavedPlaybackHeaders`, then await `probe.drain()` before next sample. Serialize/coalesce identical keys. Derive observation with Task 1, write transaction, then refresh Task 3 store only after saved acknowledgement. Preserve partial attempt and previous result when inconclusive. Register facade in app config; init state load on Sources does not itself start network checks.
- [ ] **Step 4:** Run focused tests and Task 5's Electron harness with an Xtream fixture API; assert one Live result and ordered evidence render, a later app/database reopen shows it, and immediate foreground preemption closes the test connection first. No real provider is required in automated checks.
- [ ] **Step 5:** Commit owned changes: `feat: verify and save Xtream Live source samples`. Review this milestone before continuing broad provider coverage; it must already be usable via Check again.

### Task 7: Idle scheduler, fair queue, and provider cooldowns

**Files:**
- Create: `libs/player/core/src/lib/source-check-scheduler.ts`, `.spec.ts`; export from its `src/index.ts`
- Create: `apps/desktop-ui/src/app/services/source-playback/source-playback-scheduler.service.ts`, `.spec.ts`
- Modify: `apps/desktop-ui/src/app/services/source-playback/source-playback-check.service.ts`, `apps/desktop-ui/src/app/app.config.ts`
- Modify: `libs/providers/shared/playlist-ui/src/lib/xtream-catalogue-refresh.service.ts`, `libs/services/src/lib/playlist-delete-action.service.ts`

**Interfaces:**
- Pure scheduler consumes `SourceCheckScheduleInput = { keys: readonly SourceEvidenceKey[]; supported: readonly SourcePlaybackCategory[]; due: ReadonlyMap<string, number>; busySourceIds: ReadonlySet<string>; occupied: boolean; idleSince: number | null; lastServedKey: string | null }`; key serialization is a shared `sourceEvidenceKey(key: SourceEvidenceKey): string` helper added to Task 1's contract module. `nextSourceCheck(input: SourceCheckScheduleInput, now: number): SourceEvidenceKey | null` and `sourceCheckBackoff(input: { inconclusiveCount: number; retryAfterMs?: number }, now: number): number` return scheduling choices without transport calls. The backoff count starts at one for the first inconclusive attempt.
- App scheduler `start(): () => void` subscribes to playlist lifecycle, DB operation events, ownership and evidence saves; its timer tracks ten continuous idle seconds and due times. It calls Task 6 `runCheck` with one app-scoped controller. `requestCheck` enqueues manual work, which bypasses freshness but not provider busy/throttling/cleanup. Busy operations cancel their source's queued/running work; per-provider cooldown is shared for sources using the same normalized endpoint in memory, with persisted per-source due state.

- [ ] **Step 1:** Add fake-clock tests: 9,999ms idle makes no calls; 10,000ms allows one; any foreground activity restarts idle window; a 70s slow category advances to the next source; due times follow 15m/30m/60m up to six hours and a longer Retry-After; completed checks wait 24h; duplicate manual clicks coalesce; refresh/delete/import cancel work; unsupported adapters are never automatically enqueued.
- [ ] **Step 2:** Run Node focused on both scheduler specs; expect policy/initialization failures.
- [ ] **Step 3:** Implement deterministic round-robin by source then category, with one global active lease. Use state changes plus a next-due timer, not a network polling loop per row. Busy source operations start cancellation before transport work and invalidate selection state. Persist cooldown/cursor with the attempt write; restart retains backoff. Clear timers/subscriptions on app destruction; enable only supported categories.
- [ ] **Step 4:** Run scheduler/check/ownership tests and Electron harness; expect zero overlap and no checks during user playback. Verify pause/buffer/mini/PiP/native/YouTube/external conditions individually.
- [ ] **Step 5:** Commit owned changes: `feat: schedule source checks only while playback is idle`.

### Task 8: Xtream Movies, episode samples, and reported account facts

**Files:**
- Modify: `libs/providers/xtream/data-access/src/lib/source-playback-sampler.service.ts`, `.spec.ts`
- Create: `apps/desktop-ui/src/app/services/source-playback/source-playback-account.service.ts`, `.spec.ts`
- Modify: `apps/desktop-ui/src/app/services/source-playback/source-playback-check.service.ts`, `source-playback-scheduler.service.ts`

**Interfaces:**
- Extend Task 6 sampler categories using existing `getVodInfo`, `getSeriesInfo`, `constructVodUrl`, `constructEpisodeUrl`; persist the actual selected episode identity.
- Account service `read(sourceId: string, revision: string, signal: AbortSignal): Promise<SourceAccountSnapshot | null>` uses a separate five-second account deadline within the 70-second category parent deadline, sanitized provider-reported fields, Task 2 account writes and nullable missing values. Account failures do not consume samples or erase evidence. Source checker defers at reported capacity; unknown capacity does not block. After an account read, each subsequent stage uses the remaining parent budget; three full 20-second attempts are not guaranteed if earlier work used part of it.

- [ ] **Step 1:** Add failing tests for real episode link resolution rather than series-detail success, empty seasons, hidden/removed category, missing extensions, account expiry seconds conversion, explicit no-expiry semantics versus missing/zero/malformed data, no reported connection count, full reported capacity, and timed-out account metadata with otherwise playable media. Assert five-second account timeout leaves sample attempt budgets unchanged.
- [ ] **Step 2:** Run Node focused on sampler/account/check tests; expect unimplemented category/account behavior.
- [ ] **Step 3:** Implement movie/episode candidates with fresh details at resolution time; use existing account fallbacks without mutating current provider store. Sample discovery does not download all episodes from multiple shows just to fill a list: bounded selection/detail reads share the discovery deadline. Show provider fact retrieval timestamp and Not reported where appropriate; capability-enable Movies/Series after these paths work.
- [ ] **Step 4:** Run focused tests and Electron fixture checks for one movie and one episode; verify independent category persistence and live idle-preemption behavior.
- [ ] **Step 5:** Commit: `feat: verify Xtream movies and episodes with reported account details`.

### Task 9: Stalker sampling without disturbing active portal state

**Files:**
- Create: `libs/providers/stalker/data-access/src/lib/source-playback-sampler.service.ts`, `.spec.ts`; export from its `src/index.ts`
- Modify: `libs/providers/stalker/data-access/src/lib/stalker-account-info.service.ts` and its existing tests to support cancellation/deadline options while retaining current callers.
- Modify: `apps/desktop-ui/src/app/services/source-playback/source-playback-check.service.ts`, `source-playback-account.service.ts`, `.spec.ts`

**Interfaces:**
- `StalkerSourcePlaybackSamplerService` implements Task 6 sampler, reusing `StalkerAuthApi`, saved identity/header helpers, and existing Stalker link resolution. Map UI `live`/`movies`/`series` to provider `itv`/`vod`/`series`, selecting a real episode for Series. Do not switch the global StalkerStore or trigger a playlist edit to resolve samples.
- `StalkerAccountInfoService.fetchAccountInfo(playlist: PlaylistMeta, options?: { signal?: AbortSignal }): Promise<StalkerAccountSnapshot | null>` propagates cancellation through repair waits and profile/main-info requests; app account adapter maps only fields actually reported.

- [ ] **Step 1:** Add failing tests for saved-token auth, fresh short-lived link on every attempt, full/legacy portal forms, one page with fewer than three samples, episode resolution, hidden category, cancellation during handshake/create_link, pending repair/edited credentials, and Stalker missing connection-usage fields. Include a fixture where the provider changes a token mid-response; ephemeral token refresh must not invalidate durable evidence revision.
- [ ] **Step 2:** Run Node focused on the new sampler/account tests and existing user-agent cancellation tests; use the existing Stalker Angular config only for injected Angular suites that need it.
- [ ] **Step 3:** Implement request-scoped Stalker authentication and bounded page sampling with existing transport/link helpers. Use abortable requests and fresh effective source identity; if repair changes durable endpoint/device data, obsolete the old check and requeue under the new revision. Map unknown facts to null; never invent Xtream-style connections for Stalker.
- [ ] **Step 4:** Run focused tests, existing Stalker session/repair lifecycle checks, and an Electron fixture sample per supported category. Confirm no active-portal navigation/state changes and all resources drain on cancel.
- [ ] **Step 5:** Commit: `feat: verify Stalker source playback categories`.

### Task 10: Update evidence through normal viewing

**Files:**
- Create: `apps/desktop-ui/src/app/services/source-playback/source-playback-viewing-observer.service.ts`, `.spec.ts`
- Modify: `apps/desktop-ui/src/app/app.config.ts`, `apps/desktop-ui/src/app/services/player.service.ts`
- Modify: `libs/player/ui/src/lib/workspace-player/workspace-player-state.service.ts` through narrow event hooks only
- Extend: `apps/desktop-ui/src/app/services/source-playback/source-playback-milestone.integration.spec.ts`

**Interfaces:**
- Viewing observer `start(): () => void` subscribes once to confirmed runtime events with source/item/category identity, revision and generation. Expose a narrow typed terminal-outcome callback from the automatic-playback owner only after recovery is exhausted; intermediate engine replacement is not a failure. Derive source via `itemIdentity`, `contentInfo.playlistId`, or `recovery.accountRef`; unknown identity means no evidence write.
- Persist one observation per viewing selection/check ID through Task 2. Six-second success creates/upserts it; a later final failure updates that same record and preserves `successfulAt`. Recovery attempts share that viewing identity but have separate generation guards.

- [ ] **Step 1:** Write failing tests asserting one saved success across repeated snapshots, terminal degradation updates the same ID, early stop/pause/seek/cancel does not fail, automatic fallback failure is ignored until exhausted, superseded generation is ignored, external launch without runtime confirmation stays unverified, older background completion cannot overwrite newer viewing evidence, and background probe events never enter history or this observer.
- [ ] **Step 2:** Run Node focused on observer/milestone and existing automatic-playback integration tests; expect absent writes/terminal callbacks.
- [ ] **Step 3:** Implement observer using Task 1 confirmation and Task 2 write semantics. Start lazily through app initialization after database capability is available; clean subscriptions on destroy. Handle persistence failure through the store's retryable error; never publish saved state optimistically. Keep existing playback reliability verification thresholds unchanged—source badge confirmation is its own six-second policy.
- [ ] **Step 4:** Run focused tests and a fixture viewing session followed by Sources navigation; expect saved independent category result, engine/origin detail and no instability double-count for one viewing attempt.
- [ ] **Step 5:** Commit: `feat: learn source playback evidence from normal viewing`.

### Task 11: Full acceptance, visual comparison, and graph update

**Files:**
- Extend: `tools/testing/source-playback-probe.electron.cjs`, milestone integration tests and UI tests as regressions demand
- Modify: `docs/superpowers/plans/2026-10-21-source-playback-verification.md` checkboxes/evidence and `graphify-out/` generated outputs

**Interfaces:** Consume all previous deliverables; no new product API.

- [ ] **Step 1:** Turn any uncovered acceptance failure into a targeted failing regression test before repairs. Cover source edit/delete during live request, provider ignores abort, unknown external lifetime, disk-write failure, app restart, and engine-scoped unsupported media. Do not run checks against every real saved provider for automated validation.
- [ ] **Step 2:** Run focused regression tests; confirm each added test reproduces its failure before fixing it. If all requirements are already covered, record that fact and proceed without manufacturing extra tests.
- [ ] **Step 3:** Repair only demonstrated issues. Inspect actual Sources UI through the desktop/browser tool at approximately 1440px and 700px widths. Compare the implementation screenshot and approved mockup together; check navigation, filter counts, scroll, checked age, inline history, status text/icons, focus, drag, row actions, disabled busy state, provider-status tooltip, persistence error and stale/untested states. Save no screenshots containing credentials in committed artifacts.
- [ ] **Step 4:** Run `pnpm test`, `pnpm test:angular`, dedicated Electron fixture harness, changed-source lint, and both build commands listed above. Record baseline versus new failures; do not claim feature checks passed while a relevant failure remains. Run `graphify update .` after the final code change, then `git diff --check`; inspect the complete feature diff and an independent review before integration. A large graph rewrite is expected. No deployment, publish, merge or release packaging is part of this task.
- [ ] **Step 5:** Commit only owned final fixes/docs/graph changes. Report first-milestone and full-feature acceptance separately, exact passing commands, any environment-limited live acceptance, and material engine limitations. Use the branch-finishing skill for the integration decision after verification.

## Database integration notes

The focused read-only database trace located these exact implementation points. Task 2's file list includes each applicable path below; they are not optional wiring.

| Path / symbol | Required change |
| --- | --- |
| `libs/database/src/lib/connection.ts`: `CREATE_TABLE_STATEMENTS`, `createTables`, `runMigrations`, `initDatabase` | Add initial DDL and run the idempotent transactional migration before exposing the database. Match the existing `migrateViewingState` pattern in `libs/database/src/lib/viewing-state-migration.ts`. |
| `apps/electron-backend/src/app/database/operations/playlist.operations.ts`: `upsertAppPlaylist`, `upsertAppPlaylists`, `updatePlaylist`, `deletePlaylist`, `deleteAllPlaylists` | Rotate revision atomically on identity changes, initialize new sources, cascade evidence cleanup for delete/reset. Cover both direct credential edits and full upserts. |
| `apps/electron-backend/src/app/workers/database-worker.types.ts`: `DB_WORKER_OPERATIONS` | Register `DB_GET_SOURCE_PLAYBACK_EVIDENCE`, `DB_SAVE_SOURCE_PLAYBACK_EVIDENCE`, `DB_SAVE_SOURCE_PLAYBACK_ACCOUNT`; Task 6 adds `DB_GET_SOURCE_PLAYBACK_CANDIDATES`. |
| `apps/electron-backend/src/app/workers/database.worker.ts`: `executeRequest` | Route validated requests to the new operations module. |
| `apps/electron-backend/src/app/events/database/source-playback.events.ts` (create), `apps/electron-backend/src/app/events/database.events.ts` (modify) | Register typed handlers with existing `handleWorkerRequest`, import the new event module in the existing bootstrap. |
| `apps/electron-backend/src/app/api/main.preload.ts`, `libs/shared/interfaces/src/lib/ipc-commands.ts`, `libs/shared/interfaces/src/lib/electron-api-extended.interface.ts` | Add IPC command constants and bridge implementations/types together. |
| `libs/services/src/lib/database-electron.service.ts` | Add thin typed wrappers consumed by the dedicated evidence repository; keep IPC naming consistent. |
| `apps/electron-backend/src/app/events/database/worker-ipc-contract.spec-data.ts` | Extend the typed fixture with every new operation. There is no existing consuming contract suite in this checkout; create/run `apps/electron-backend/src/app/events/database/source-playback-ipc.spec.ts` for the new handlers and dispatch paths rather than referring to a nonexistent worker-ipc-contract.spec.ts. |
| `apps/electron-backend/src/app/database/operations/content.operations.ts`: `getContent` | Existing read has no limit; do not reuse it for sample selection. Task 6 adds `getSourcePlaybackCandidates(db, { sourceId, category, limit: 3, cursor, preferredItemId })` in the new source-playback operations module with typed IPC/bridge wrapper. Return at most three available items and exclude hidden categories before LIMIT. |

Task 2 additionally creates `apps/electron-backend/src/app/database/operations/source-playback-lifecycle.spec.ts` to cover both upsert and direct edit/delete/reset routes. Include it in its focused red/green command. No existing playlist identity/credential data may be duplicated into evidence rows. Account values remain separate, nullable, provider-reported snapshots.

For candidate reads, order by deterministic `(category_id, id)` with a cursor, prefer a previous successful eligible ID once, then wrap to fill remaining slots without duplicates. Validate `limit` in the worker (1–3) and resolve source type/category mapping in the provider adapter. Stalker candidates use bounded portal pages rather than assuming Xtream catalogue rows exist.

## Execution recommendation

Use **Native** execution in this chat: the tasks share evidence, ownership and cleanup contracts, and the workspace already has player changes that need one consistent owner. A focused read-only worker can research a bounded integration point; actual implementation remains sequential. Use a fresh independent reviewer once the whole change is ready. Alternatively, choose subagent-driven execution with one implementer/reviewer cycle per task; avoid concurrent edits of shared player, IPC or contract files.

Implementation begins after the user reviews this plan and chooses the execution approach.
