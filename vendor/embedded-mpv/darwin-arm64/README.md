# darwin-arm64 Embedded MPV Runtime

Generate this folder with:

```bash
node tools/embedded-mpv/stage-macos-runtime.mjs arm64 /path/to/lgpl-prefix
```

The generated `include/`, `lib/`, and `runtime-manifest.json` files are release inputs and are ignored by git by default.
