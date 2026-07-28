# Refactor notes

This package is a disruptive simplification pass. It intentionally narrows the runnable product before deeper cleanup.

Completed:

- Removed the remote-control application, HTTP server, Electron bridge, settings, and player listeners.
- Removed Downloads and Stalker routes from the renderer.
- Kept Embedded MPV, ArtPlayer, HTML5, external MPV, and VLC selectable on supported runtimes.
- Made ArtPlayer the safe default.
- Removed Video.js packages and generated build output.
- Reduced root scripts to one development, build, package, and clean path.

Deferred compatibility cleanup:

- Stalker/download database schema and source remain where migrations and shared collection code may still depend on them.
- Shaka remains as an internal compatibility dependency of the existing ArtPlayer source session until DASH/DRM handling is removed or isolated.

## Protected playback features

VLC, external MPV, and HTML5-player features are protected from further cleanup and remain selectable on supported desktop runtimes. Video.js and its remaining implementation traces have been removed. Do not remove, disable, or refactor the protected players' code, configuration, dependencies, selection values, or migration support without explicit approval.

Expect follow-up compile fixes because this refactor deliberately changes multiple product boundaries at once.
