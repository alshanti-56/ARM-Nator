# ARM-Nator simplified architecture

## Product boundary

The active product is one Electron desktop application with one Angular renderer.

Active source types: M3U and Xtream.

Active playback engines:

1. Embedded MPV (`embedded-mpv`) — experimental, native, primary option.
2. ArtPlayer (`artplayer`) — web fallback using HLS.js and MPEG-TS.js.
3. HTML5 (`html5`) — built-in browser playback.
4. External MPV (`mpv`) — managed desktop player.
5. VLC (`vlc`) — managed desktop player.

The remote-control application and backend server have been removed. Downloads and Stalker remain outside the active product boundary; legacy code may remain temporarily where shared models or migrations still reference them.

### Protected playback features

VLC, external MPV, and HTML5-player features are intentionally preserved and selectable on supported desktop runtimes. Do not remove, disable, or refactor their source code, configuration, dependencies, selection values, or migration support as part of product-boundary cleanup. Video.js has been removed. Any future change to the preserved playback features requires explicit approval.

## Runtime flow

```text
Angular feature -> PlayerFacade -> selected player adapter
Angular service -> typed preload bridge -> Electron service -> SQLite / HTTP / native MPV
```

## Source structure

```text
apps/
├── desktop-ui/           Angular desktop renderer
└── electron-backend/     Electron main process and native integration

libs/
├── player/
│   ├── core/             engine registry and application-facing PlayerFacade
│   └── ui/               all five player implementations
├── providers/
│   ├── m3u/              M3U state, utilities, and player feature
│   ├── xtream/           Xtream data access and features
│   └── shared/           normalized provider contracts and shared UI
├── database/             SQLite schema and shared database runtime
├── epg/                  EPG data access and UI
├── settings/             settings data access and UI
├── shared/               interfaces and logging
├── ui/                   reusable non-player presentation
└── workspace/            desktop shell and dashboard
```

The `@arm-nator/player/core` boundary owns the list of supported players,
runtime availability rules, engine classification, and the `PlayerFacade`
contract. Feature code must call this boundary rather than importing a player
implementation.

Directory cleanup must never remove or disable VLC, external MPV, HTML5,
ArtPlayer, or embedded MPV.

## Development commands

```bash
pnpm dev
pnpm build
pnpm package
pnpm clean
```

## Refactoring rule

New UI code must not import native MPV implementation details. New playback behavior belongs behind the player boundary. Provider-specific responses must be normalized before reaching shared UI.
