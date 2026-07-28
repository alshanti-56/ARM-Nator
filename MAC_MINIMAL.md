# ARM-Nator — minimal macOS development source

This copy keeps only the source and build support required for the Electron macOS application.

## Requirements

- macOS
- Xcode Command Line Tools: `xcode-select --install`
- Node.js version expected by the repository
- pnpm through Corepack: `corepack enable`
- Homebrew dependencies required by the embedded MPV native module

## Install

```bash
pnpm install --frozen-lockfile
```

## Develop with live reload

```bash
pnpm dev
```

## Build

```bash
pnpm build
```

## Create a macOS package

Apple Silicon only:

```bash
pnpm package
```

Packages use local ad-hoc signing and are intended for this Mac. Distribution
outside your Mac would require Apple Developer signing and notarization, which
are intentionally not configured.

The local package command may bundle the Homebrew libmpv runtime installed on
this Mac. That allowance is explicit to this command and is not suitable for a
publicly distributed release.

## Retained applications

- `apps/desktop-ui` — main Angular interface
- `apps/electron-backend` — Electron main process and macOS native integration

Shared production libraries remain under `libs/`. Required native and packaging support remains under `vendor/`, `tools/embedded-mpv`, and `tools/packaging`.
