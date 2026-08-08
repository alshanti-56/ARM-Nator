# Releasing ARM-Nator

Releases are created by GitHub Actions when a semantic-version tag is pushed.
The tag must match the version in `package.json`.

```sh
git tag -a v0.25.0 -m "Release v0.25.0"
git push origin main
git push origin v0.25.0
```

To rerun a failed release without moving its tag, run the workflow manually
from GitHub Actions and enter the existing tag in the `release_tag` field.

The workflow runs on an Apple Silicon `macos-26` runner, verifies the version,
builds the pinned Embedded MPV and KSPlayer runtimes, packages the arm64 DMG
and ZIP, creates SHA-256 checksums, and publishes a GitHub Release with the
artifacts.

The current packaging configuration uses ad-hoc signing and does not notarize
the application. Distribution signing and notarization can be added later
without changing the tag workflow.
