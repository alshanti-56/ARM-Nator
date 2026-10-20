# Private browser media companion

This optional Node.js service gives a single-owner browser client a local, credential-safe path to IPTV and other authorized media sources. It uses only Node built-ins and keeps provider credentials and source URLs on the companion side. It is not intended as a public proxy or a shared hosting service.

Run it with Node.js 20 or later:

```sh
MEDIA_COMPANION_ALLOWED_HOSTS=iptv.example,192.168.1.20 \
MEDIA_COMPANION_ALLOWED_ORIGINS=http://127.0.0.1:4300,http://localhost:4300 \
node tools/media-companion/server.mjs
```

For ARM-Nator's bundled macOS FFmpeg, set `MEDIA_COMPANION_FFMPEG="$PWD/apps/electron-backend/native/build/Release/ffmpeg"` before the command. Conversion additionally needs a working `MEDIA_COMPANION_FFPROBE` executable; the bundled runtime does not currently include it.

The listener defaults to `127.0.0.1:4321`. On startup it prints a process-local pairing bearer token once. The token is regenerated each process unless `MEDIA_COMPANION_TOKEN` is configured; configured tokens must contain at least 24 bytes. Store it in the client runtime only. The client should not persist it in ordinary playback settings or include it in a media URL.

## Source and audience security

The companion is private single-owner by audience. A source does not need a private IP address: a public provider host is supported when its exact hostname or IP is added to `MEDIA_COMPANION_ALLOWED_HOSTS`. Private LAN and loopback sources also need an exact allowlist entry. Wildcards are not supported. Metadata, link-local, multicast, and reserved destination ranges stay blocked even if listed. DNS results are checked and the chosen address is pinned for each request; redirects and HLS child URLs are checked under the same policy. On a cross-origin redirect or HLS child, only safe negotiation and range headers are retained; authorization, cookies, and all custom headers are dropped.

Source URLs may include query tokens or URL user information, and callers may pass source headers in the create request. The companion removes user information from stored request URLs, converts it to an upstream Authorization header, and never returns the source URL, source headers, or those credentials in session metadata or scoped media URLs. Treat the companion host and process as trusted with those source credentials.

Browser requests must use an exact configured origin. `MEDIA_COMPANION_ALLOWED_ORIGINS` is a comma-separated list such as `http://localhost:5173,https://player.example`; wildcard origins are rejected. Control routes require `Authorization: Bearer <pairing token>`. Media routes use per-session opaque capabilities in their paths, so treat each returned `url`/`mediaUrl` as a secret.

For a remote companion, put a trusted HTTPS reverse proxy in front of the service. Set all of the following: `MEDIA_COMPANION_HOST=0.0.0.0`, `MEDIA_COMPANION_TRUSTED_HTTPS_PROXY=1`, exact `MEDIA_COMPANION_ALLOWED_ORIGINS`, and an HTTPS origin-only `MEDIA_COMPANION_PUBLIC_BASE_URL` that the browser can reach. Configure the proxy to terminate TLS and route `/api/*` and `/media/*` to the companion. The service does not trust forwarded host or protocol headers. Restrict network access to the proxy and the single owner.

## API

All endpoints are version 1 and send `Cache-Control: no-store` on control responses.

| Request | Purpose |
| --- | --- |
| `GET /api/capabilities` | Authenticated feature, session, and runtime conversion capabilities |
| `POST /api/sessions` | Create a playback session |
| `GET /api/sessions/:id` | Read session status and track/limitation metadata |
| `POST /api/sessions/:id/heartbeat` | Refresh the session lease |
| `DELETE /api/sessions/:id` | Immediately abort work and release the session |
| `GET` / `HEAD /media/:capability/:resource` | Stream the root resource and scoped HLS children |

Create request example:

```json
{
  "url": "https://iptv.example/live/channel.ts?token=source-secret",
  "headers": { "Authorization": "Bearer source-secret" },
  "mode": "proxy",
  "isLive": true
}
```

`mode` is `proxy` by default and can be `remux` or `convert`. The response is a flat session object with `id`, `url`, `mediaUrl`, `format`, `container`, `mode`, `processingMode`, `status`, `startTime`, `timelineOffsetSeconds`, `durationSeconds`, `encoderMode`, `videoEncoder`, lease timestamps, `heartbeatIntervalMs`, track metadata, limitations, and any processing error. Duration is the original VOD duration when known; remux can populate it from FFmpeg's generated HLS playlist after completion if ffprobe is absent. Clients should heartbeat at the returned interval (15 seconds with the default 60-second lease). At most two sessions may exist; at most one conversion may run, with no queue. Each session retains at most 4096 opaque upstream resource entries in a bounded LRU; an HLS manifest that alone exceeds the bound fails visibly. Deleting or expiring a session aborts upstream requests and FFmpeg children and removes generated files.

Proxy mode streams source media and byte ranges and rewrites HLS playlists to scoped opaque resource paths. It reports source format/container hints based on the URL extension and uses `unknown` when it cannot infer them.

Remux mode asks FFmpeg to stream-copy mapped tracks into HLS. Track retention depends on the input and FFmpeg muxer; unsupported track codecs fail the session visibly. It does not transcode.

Conversion requires both the service setting `MEDIA_COMPANION_ENABLE_CONVERSION=1` and the request field `allowConversion: true`. The service probes its actual FFmpeg runtime for `ffprobe`, AAC, scaling, and a usable H.264 encoder before it advertises conversion. It prefers a proven hardware H.264 encoder and only falls back to a proven `libx264` encoder with two threads. Video output is 8-bit H.264 SDR, preserves aspect ratio, does not upscale, and is capped at 1920x1080; audio output is AAC from the first audio track. When `audioOnly: true` (or `audioFirst: true`), audio is converted first while compatible H.264 video is copied; other video is converted to the output profile. Subtitle and alternate audio tracks are reported as conversion limits and are not silently treated as preserved. Requests that explicitly select a video, audio, or subtitle track, or request subtitle burning, receive `track_selection_unsupported`. HDR input requires a proven zscale/tonemap path. VOD remux and conversion accept `startTime` in seconds; the response reports `timelineOffsetSeconds`. Proxy-mode seeking and live seek are rejected.

Capability probing proves encoder/filter availability, but only a successful real-media session verifies a particular source and machine end to end. This package's fixture tests do not claim that conversion works on every FFmpeg build.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEDIA_COMPANION_HOST` | `127.0.0.1` | Bind address; remote binds require the proxy settings above |
| `MEDIA_COMPANION_PORT` | `4321` | Local HTTP port |
| `MEDIA_COMPANION_TOKEN` | random per process | Pairing bearer token, minimum 24 bytes when configured |
| `MEDIA_COMPANION_ALLOWED_HOSTS` | `127.0.0.1,localhost,::1` | Exact upstream host allowlist |
| `MEDIA_COMPANION_ALLOWED_ORIGINS` | empty | Exact browser origins |
| `MEDIA_COMPANION_TRUSTED_HTTPS_PROXY` | `0` | Must be `1` to bind outside loopback |
| `MEDIA_COMPANION_PUBLIC_BASE_URL` | unset | Browser-facing base URL; required and HTTPS for remote binds |
| `MEDIA_COMPANION_ENABLE_CONVERSION` | `0` | Server-side conversion opt-in |
| `MEDIA_COMPANION_FFMPEG` | `ffmpeg` | FFmpeg executable path |
| `MEDIA_COMPANION_FFPROBE` | `ffprobe` | FFprobe executable path |
| `MEDIA_COMPANION_SESSION_TIMEOUT_MS` | `60000` | Lease duration without heartbeat |
| `MEDIA_COMPANION_REQUEST_TIMEOUT_MS` | `20000` | Upstream request socket timeout |

## Tests and container

Run the local-fixture API/security tests with:

```sh
node --test tools/media-companion/test/*.test.mjs
```

An optional real-media remux check uses a local MPEG-TS fixture and FFmpeg binary:

```sh
MEDIA_COMPANION_TEST_MEDIA=/path/to/local-fixture.ts \
MEDIA_COMPANION_TEST_FFMPEG=/path/to/ffmpeg \
node --test tools/media-companion/test/ffmpeg.integration.test.mjs
```

The Dockerfile installs FFmpeg and FFprobe in the image. The default container configuration remains loopback-bound; set the remote reverse-proxy environment explicitly when using it behind HTTPS.
