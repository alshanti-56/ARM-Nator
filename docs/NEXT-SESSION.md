# Current handoff

Last updated: 18 October 2026. This file replaces earlier session handoffs.
Use the project README for supported features and this file for delivery state.

## Installed application

- Application: `dist/executables/mac-arm64/ARM-Nator.app`.
- Version: `0.31.0`.
- app.asar SHA-256: `75d1b448d7bbe945a7d7a31f7f33c673074162d3f82ad72b1dee17e3e69962f6`.
- Latest verified installation: [delivery.json](delivery.json).
- Rollback: `dist/executables/backups/stalker-counts-20261018/`.
- The documentation cleanup did not rebuild, replace, or change the app.

## Supported source boundary

Add Source exposes Xtream and Stalker. M3U channel-playlist URL/file import
is not connected. Individual `.m3u8` playback through Direct Play remains
separate from source import. Generic channel/group components are shared with
the player sidebar; their presence does not establish M3U import support.

## Latest verified changes

Stalker counts every loaded item by opaque category ID. The sidebar and Manage
Categories share those counts. Complete live lists use local exact counts;
paged Movies/Series retain known provider totals or display loaded lower
bounds with `+`. Unknown totals remain unknown. Visibility preferences remain
separate for each source and Live TV/Movies/Series section.

The 18 October count delivery passed 8 Node tests, 5 Angular tests, UI TypeScript,
and focused lint with 0 errors and one existing file-length warning. Production
packaging, deep/strict ad-hoc signature verification, ZIP integrity/hash and
DMG checksum passed. Actual Stalker live data showed 23,833 loaded channels:
Pay Per View 35, UFC 6, Boxing 17 in both sidebar and manager. These are dated
observations, not fixed provider catalogue sizes or a fresh full-suite run.
Evidence remains in `.superpowers/sdd/stalker-category-counts-20261018/`.

## Earlier delivered behavior to preserve

- Xtream and Stalker category management; scoped dialog sizing, search, scrolling,
  save/cancel, persistent visibility, and corrected Stalker account layout.
- Native video beneath the Angular foreground; controls/settings/tooltips above
  video, plus a floating mini-player over Browser/YouTube pages.
- Watched-frame thumbnails for HTML5/ArtPlayer: bounded RAM cache, 120 frames or
  2 MiB, at most one sample per 30-second watched interval. No extra media fetch
  or seek for capture; restart clears captured frames. Native engines still
  rely on supplied previews. No promise of unwatched full-timeline previews.
- Shared viewing progress/preferences, conservative work matching, versions,
  automatic version ranking, and explicit portal search. Historical four-stage
  acceptance reports are in the archive; later fixes were not a full re-audit.
- Original playback diagnostic URLs/headers/cookies remain locally replayable.
  Do not silently redact the original records or infer media authorization
  merely from a successful provider login.

## Known limitations and remaining work

- Chromium Escape can exit HTML fullscreen before closing Settings/dock menus.
- Earlier newly signed test clones sometimes stalled before readiness in a
  filesystem open. Their exact first-launch cause was not established;
  universal cold-start performance is not verified.
- HDR, multiple display scales, VoiceOver, screen sharing, forced MPV software
  decoding, and systematic dropped-frame measurements lack broad acceptance.
- Broad provider compatibility is incremental. A 401/recovery alone does not
  establish why a server rejected a request; retain request-level evidence.
- M3U source import is unavailable. No code removal or M3U restoration was
  performed during documentation cleanup.

## Working conventions

Preserve uncommitted work. The user requested primary-agent implementation
without Luna/delegation and revoked the old usage-limit pause rule.
Use CUA for GUI actions. Avoid DevTools during native transparency QA because
it makes Electron windows opaque. Verify a packaged result before calling it
installed, and distinguish focused checks from full-suite acceptance.

Update this handoff in place. Keep one [documentation guide](README.md) and one
current delivery record. Historical originals and reports are recoverable from
the sibling archive described in the guide; screenshot/log evidence and build
backups remain in their original locations.

## Graphify navigation

Graphify is installed through uv. Its saved interpreter pointer was corrected
to the current user's uv tool environment. The 18 October structural app-code
map is in `graphify-out/app-code-20261018/` (198 files, 2,644 nodes, 5,991 edges),
with HTML, report, raw extraction and health diagnostics. The full repository
graph at `graphify-out/graph.json` was left unchanged. The scoped map excludes
library internals and semantic document/image extraction; one native header
was not parsed and out-of-scope references remain unresolved. Use it for
navigation and verify runtime claims in code and the packaged app.

The expanded structural code map is in
`graphify-out/repository-code-20261018/`: 1,148 code/config files across apps,
all ten library areas, tools, scripts and root configuration; 11,140 nodes,
26,962 edges and 456 communities. Use
`GRAPHIFY_OUT="$PWD/graphify-out/repository-code-20261018"` with the installed
Graphify executable to query this map. Its HTML is a community overview; the
JSON retains individual symbols. Both previous graphs remain unchanged.
Documentation, HTML templates, workflow YAML, images, dependencies and build
outputs are outside this structural pass. The Word plan could not be converted
and was left untouched. Health diagnostics retain 130 dangling edges, 115
self-loops and 1,383 collapsed undirected relations; raw edges remain available
in `extraction.json`. The KSPlayer ABI header passed strict compiler syntax
checks in C17, C++17 and Objective-C++17. A throwaway-copy reproduction isolated
Graphify's conditional extern-C parsing limitation; its C extractor also omits
plain prototypes. The expanded map now supplements 22 declarations from Clang
AST, with exact source lines and no invented calls. See
`native-header-audit.json` and `audit-native-header.py` in the map directory.
`build-map.py` validates the header hash before including this supplement; rerun
the audit if the header changes. App source and the installed Graphify package
were unchanged. Older maps retain the original omission.
