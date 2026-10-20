# CDN cookie playback

The Electron media proxy saves `Set-Cookie` responses and supplies applicable
cookies on later requests within the same playback session. This supports CDNs
that establish their session during a redirect or manifest request and require
that session for segments, encryption keys, subsequent manifests, or byte ranges.

## Behavior

- A separate in-memory tough-cookie jar belongs to each proxy playback session.
  Account sessions are not pooled by hostname and cookies are not persisted.
- Domain, path, Secure, expiry, deletion, and cookie-prefix rules determine which
  learned cookies are sent. Invalid cookies and public-suffix domains are ignored.
- Without account-policy overrides, manually supplied Cookie and Authorization
  headers remain restricted to the original source origin. Once a redirect
  leaves that origin, the chain does not restore those manual credentials, even
  if it returns to that origin. Learned playback cookies follow their validated
  cookie scopes. Explicit account and license policies are separate inputs.
- A response replacing or deleting a manually supplied cookie masks the older
  value for the matching scope. Expiry does not resurrect an older manual value.
- Each jar is bounded to 64 cookies and 64 KiB serialized storage. A response
  processes at most 32 cookies, each at most 4 KiB. The manual-cookie mask jar has
  the same bounds; overflow suppresses manual cookies for that session rather
  than resurrecting a revoked value.
- Redirects are limited to 20 follows. Intermediate bodies are cancelled and
  session release aborts the request chain and clears the jars.
- HLS manifests/resources, progressive VOD ranges/prefetch, and MPEG-TS proxy
  requests use this path. A player using a prepared proxy URL benefits from
  this transport; a direct browser/native/external request bypasses it.
- A request policy with `accountRef` can select an account snapshot. Enabling
  `loginCookies` supplies that account's login cookies; `portalCredentials`
  enables its portal credentials and headers. These are explicit policy-driven
  inputs, separate from the domain/path filtering of learned playback cookies.
  Account profiles are selected by identity rather than just the hostname.
- Auto fetches and inspects the first response, then retains it for playback.
  A 401 response that supplies a usable cookie can trigger one controlled retry
  under the same startup deadline. A 401 without that evidence is not treated
  as a cookie challenge. Request, session, inspection, retry and release events
  are correlated in diagnostics.

Cookies do not solve browser challenges, missing media entitlement, server
outages, or unsupported decoding. A 401 without a relevant cookie exchange is
not evidence of a cookie problem.

Historical fixture results and provider observations are preserved in the local
[documentation archive](README.md#historical-records). They describe their
original build and should not be treated as verification of later changes.

## Trace anchors

- [Auto preparation](../apps/electron-backend/src/app/services/automatic-playback-api.ts)
  calls the proxy and preserves typed inspection failures across IPC.
- [Proxy transport](../apps/electron-backend/src/app/services/hls-playback-proxy.service.ts)
  owns startup inspection, redirect/cookie fetching and release acknowledgements.
- [Playback cookies](../apps/electron-backend/src/app/services/playback-cookie-session.ts)
  stores and selects learned cookies.
- [Player orchestration](../apps/desktop-ui/src/app/services/player.service.ts)
  supplies prepare/cancel/release callbacks and logs the selected engine/reason.

The Graphify app map is a navigation aid. Source verification and focused
loopback tests establish these specific paths; they do not diagnose an earlier
real-provider rejection or guarantee all provider authentication schemes.
