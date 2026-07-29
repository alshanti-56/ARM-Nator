# Embedded MPV Runtime Artifacts

This directory stages the generated macOS arm64 embedded-MPV runtime:

```text
vendor/embedded-mpv/darwin-arm64/
  include/mpv/client.h
  lib/*.dylib
  runtime-manifest.json
```

The generated headers, libraries, and manifest are release inputs and are
ignored by Git. Build and stage them with the scripts documented in
`tools/embedded-mpv/README.md` before creating a production package.
