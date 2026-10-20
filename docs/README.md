# Documentation guide

| Document | Purpose |
| --- | --- |
| [Project README](../README.md) | Supported features, source types, routes, and development commands |
| [Current handoff](NEXT-SESSION.md) | Installed build, recent verification, limitations, and remaining work |
| [Delivery record](delivery.json) | Machine-readable identity and evidence for the latest verified installation |
| [Toolchain maintenance](toolchain.md) | Version pins, native rebuild policy, and compatibility exceptions |
| [Playback diagnostics](playback-diagnostics.md) | Local logs, replay/export commands, and interpreting failures |
| [CDN cookie playback](cdn-cookie-playback.md) | Cookie isolation, redirect behavior, and transport boundaries |
| [Releasing](RELEASING.md) | Packaging and GitHub release workflow |
| [Historical upgrade plan](history/Future%20Work%20-%20ARM-Nator%20Upgrade%20Plan.docx) | Original Word roadmap; historical reference, not current product status |

## Keeping this small

- Update an existing guide when behavior changes. Add a guide only for a
  distinct, durable topic that does not fit one of these documents.
- Replace the current handoff; do not append superseded "current" sections.
- Update `delivery.json` only after verifying an actual installed build. A
  documentation change does not create a new application delivery.
- State whether behavior is implemented, tested, or installed. A file's
  existence alone does not establish an accessible product feature.
- Keep per-run logs, screenshots, fixture outputs and scratch work outside the
  active documentation. Historical test results are not current test passes.
- Keep dependency documentation inside installed dependencies/test bundles;
  exclude it from counts of project-authored guides.

## Historical records

Earlier plans, delivery manifests, design reviews, screenshots and session
notes were consolidated on 18 October 2026 into the local sibling archive:
[ARM-Nator documentation archive](../../ARM-Nator-documentation-archive-2026-10-18/README.md).
It is outside this Git checkout and is not part of a distributed repository.

The archive preserves original repository-relative paths under `originals/`
and includes a SHA-256 manifest. Copy a file back to its original path to
recover it, comparing with current work before overwriting anything.
Application code, test bundles, profiles and fixture inputs were left in place.
The original Word upgrade plan is preserved under `docs/history/`.

## Folder organization and local artifacts

- `apps/` contains application entry points and native integrations; `libs/`
  contains shared and domain libraries. `tools/` contains repository automation,
  including the optional production launcher `tools/build_and_run.sh`.
- `dist/apps/` and `dist/libs/` contain generated build output.
  `dist/executables/` contains the current packaged app and distribution files.
- Keep the current package and the rollback named in `delivery.json`. Older
  packaging checkpoints and superseded backups can be removed once no running
  process uses them and they are not needed for an active investigation.
- Keep per-session logs, screenshots and measurements in `.superpowers/`;
  use `tmp/` for temporary fixtures and performance work. Remove superseded
  app copies after verification instead of retaining a full app per checkpoint.
  Preserve the evidence directory named in `delivery.json`.
- Keep repository graph output under the root `graphify-out/`; avoid incidental
  output directories inside `apps/`, `libs/`, `tools/` or `docs/`.
- Native caches under `apps/electron-backend/ksplayer-metal/.build/` and
  `apps/electron-backend/native/build/`, dependencies and the vendored runtime
  are separate from disposable checkpoints. Retain them for normal development.

The 18 October 2026 artifact cleanup retained the current app, its recorded
rollback and delivery evidence. Its local removal manifest and source-integrity
checks are in `tmp/repo-cleanup-2026-10-18/`.
