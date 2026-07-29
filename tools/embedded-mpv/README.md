# Embedded MPV Runtime

ARM-Nator targets macOS 26 or newer on Apple Silicon. The only supported
embedded-MPV runtime is `darwin-arm64`.

## Runtime policy

Release builds use a pinned, LGPL-compatible, dynamically linked runtime:

- FFmpeg is built without GPL or nonfree features.
- mpv is built with libmpv enabled and GPL disabled.
- Runtime dylibs remain individually replaceable under `native/lib`.
- Runtime versions, sources, build flags, licenses, and checksums are recorded
  in `runtime-manifest.json`.

Homebrew is not used. Development, production builds, and packaged apps all
require the vendored runtime.

## Generated layout

```text
vendor/embedded-mpv/darwin-arm64/
  include/mpv/client.h
  lib/*.dylib
  runtime-manifest.json
```

The generated runtime contents are ignored by Git.

## Build and stage

Build the pinned macOS arm64 runtime:

```bash
pnpm embedded-mpv:runtime
```

This builds the runtime when it is missing and stages it into the repository.
The lower-level commands remain available when a clean rebuild is required:

```bash
node tools/embedded-mpv/build-macos-runtime.mjs /tmp/arm-nator-mpv
node tools/embedded-mpv/stage-macos-runtime.mjs /tmp/arm-nator-mpv
```

Build the Electron native addon and helper:

```bash
pnpm embedded-mpv:build
```

The build produces:

```text
apps/electron-backend/native/build/Release/
  embedded_mpv.node
  embedded_mpv_frame_reader.node
  arm-nator_mpv_helper
  embedded-mpv-runtime.json
  lib/*.dylib
```

## Packaging

The `prepackage` lifecycle ensures the portable runtime exists.
`electron-after-pack.cjs` copies the native output into
`app.asar.unpacked/electron-backend/native`, verifies that all required arm64
artifacts exist, rejects Homebrew and other absolute runtime links for release
packages, and validates the dylib closure with `otool`.

The application, native addon, helper, runtime manifest, and dylibs are all
macOS arm64-only and have a deployment target of macOS 26.0.
