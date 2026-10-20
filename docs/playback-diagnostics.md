# Permanent playback diagnostics

ARM-Nator records provider API requests and playback requests locally in both
development and production. Diagnostics observe the existing request and
recovery paths; they do not change headers, select another player, make extra
provider requests, or change retry behavior.

## Files and access

The default file is `~/.arm-nator/logs/playback-diagnostics.jsonl`.
The app uses an active 2 MiB file and two rotated archives, for at most 6 MiB
of retained history. Old records are replaced when that limit is reached.
The log directory has owner-only access and files have mode `0600`.
The E2E data-directory override also relocates diagnostics.

Original records retain exact URLs, query tokens, request headers, response
headers, authorization values, and cookies. This allows replay outside the app.
They are stored locally and are not uploaded automatically. The logger does not
store media bodies or entire channel catalogs.

```bash
pnpm diagnostics:playback
pnpm diagnostics:playback --last 100
pnpm diagnostics:playback --session SESSION_ID --json
pnpm diagnostics:playback --last 10000 --json > playback-report.json
pnpm diagnostics:playback --last 10000 --json --redact > playback-sharing-report.json
```

The command selects the last 40 records by default; `--last` accepts up to 10000.
`--json` exports the selected original records. `--redact` creates an optional sharing
copy that omits URL paths/query strings, headers, and free-form error text. It
does not change the original files. The default command displays a compact
status/host/timing summary. No diagnostic command opens a stream.

## What is recorded

- Xtream and Stalker API response statuses, individual redirect hops, request
  headers, timings, errors, and operation names.
- Xtream authentication and active/max connection counts when present in the
  provider's API response. HTTP 200 alone is not classified as authenticated.
  Stalker handshake acceptance and known HTTP-200 authorization failures are
  distinguished from ordinary successful responses.
- HLS manifests/resources, MPEG-TS streams, and progressive media requests:
  original source, requested and final response URLs, statuses, retry phases,
  request/session/resource identifiers, and active local proxy sessions.
- Node/Undici wire requests and responses, including automatically added
  headers, HTTP reason phrases, and each redirect hop. This exposes the actual User-Agent and which
  HTTP host returned a rejection without changing the request.
  These wire records also contain cookies added by the playback session jar.
  A high-level response record's configured request headers are not a substitute
  for the actual wire headers when comparing cookie-authenticated requests.
- Native Embedded MPV and KSPlayer load requests, explicit playback headers,
  status transitions, errors, and session release. Their internal HTTP
  exchanges are handled by native libraries and are not captured by the Node
  fetch observer; the native records describe load intent and player state.

Browser decoder errors remain available in the player's Technical details;
the permanent network records capture the provider exchange, rather than a
browser decoder stack trace. HTTP success alone does not establish that a
browser can decode the media.

## Authentication succeeds but playback fails

API authentication and media authorization are separate steps. Compare the
provider API event with the manifest/resource events for the same source and
time period:

| Evidence | What it establishes |
| --- | --- |
| API response with `providerAuth: true` | The account/API authentication was accepted |
| API HTTP 200 without an authentication field | The API request completed; authentication state is unknown |
| Original gateway returns 401 before redirect | The gateway rejected that playback request |
| Gateway redirects, media host returns 401 | The redirected host rejected the request |
| Request changes from 401 to 200 after original-URL refresh | Recovery/re-resolution succeeded; the reason for the original rejection still needs evidence |
| Actual User-Agent or credential headers differ between attempts | The successful and failed requests were not equivalent |
| Active/max connection values are present | The provider-reported connection snapshot can be compared with the failure |

Local proxy-session counts are not the provider's account connection counts.
A recorded 401 alone cannot distinguish credentials, token expiry, account
restrictions, or provider policy. Exact redirect/token/header records permit a
controlled comparison; they do not automatically prove the provider's reason.

## Failure handling and verification

Writes are asynchronous. The pending write backlog is bounded by both 256
records and 2 MiB, including the active write. Oversized records and overflow
are dropped with a console notice. A disk failure stops the recorder for that
process and reports it once; playback continues. Resolve the storage issue and
restart the app to resume recording.

Tests exercise actual loopback HTTP servers, redirects, authentication success
followed by media rejection, 401 recovery, network failures, cancellation,
concurrent request correlation, exact replay retention, optional sharing
exports, file rotation/permissions, bounded malformed-record floods, and disk
failures. No provider traffic is required for these checks.

Historical provider observations are in the local
[documentation archive](README.md#historical-records). They describe the
requests captured at that time, rather than a permanent provider diagnosis.

The proxy's session-cookie behavior and its verification are described in
[CDN cookie playback](cdn-cookie-playback.md). Its cookies live in memory for one
playback session; exact diagnostic records remain subject to the existing local
retention policy.

Auto playback records `automatic-playback-decision` with the original source,
session ID, selected engine, and reason. Preparation records `auto-media-inspected`;
a controlled cookie retry uses `auto-cookie-challenge-retry`.

See [the current handoff](NEXT-SESSION.md) and [delivery record](delivery.json)
for the latest installed build and the scope of its verification. Historical
suite totals and provider comparisons remain in the documentation archive.
