import assert from "node:assert/strict";
import test from "node:test";
import "@angular/compiler";
import { createPlaybackSourceMetadata } from "../playback-diagnostics/playback-diagnostics.util";
import { PlaybackDiagnosticCode } from "../playback-diagnostics/playback-diagnostics.model";
import {
  classifyShakaPlaybackIssue,
  extractShakaNetworkFailure,
} from "./shaka-error-classifier";

const metadata = createPlaybackSourceMetadata({
  url: "https://provider.test/live/manifest.mpd",
  mimeType: "application/dash+xml",
  player: "artplayer",
});

test("Shaka preserves proxy network identity and Retry-After for resource failures", () => {
  const error = {
    category: 4,
    code: 1001,
    data: [
      "http://127.0.0.1/dash/opaque/resource",
      404,
      "",
      {
        "x-arm-nator-request-id": "request-42",
        "x-arm-nator-resource-kind": "segment",
        "retry-after": "7",
      },
      1,
    ],
  };
  assert.deepEqual(extractShakaNetworkFailure(error), {
    status: 404,
    resourceKind: "segment",
    requestId: "request-42",
    retryAfterSeconds: 7,
  });
  const issue = classifyShakaPlaybackIssue(error, metadata);
  assert.equal(issue.network?.requestId, "request-42");
  assert.equal(issue.network?.resourceKind, "segment");
  assert.equal(issue.network?.retryAfterSeconds, 7);
});

test("license 403 stays a distinct provider rejection with structured network data", () => {
  const issue = classifyShakaPlaybackIssue(
    {
      category: 1,
      code: 1001,
      data: [
        "https://license.provider.test/wv",
        403,
        "",
        {
          "x-arm-nator-request-id": "license-request-8",
          "x-arm-nator-resource-kind": "license",
          "retry-after": "2",
        },
        2,
      ],
    },
    metadata,
  );
  assert.equal(issue.code, PlaybackDiagnosticCode.ProviderRejected);
  assert.equal(issue.network?.status, 403);
  assert.equal(issue.network?.resourceKind, "license");
  assert.equal(issue.network?.requestId, "license-request-8");
  assert.equal(issue.network?.retryAfterSeconds, 2);
  assert.equal(issue.externalFallbackRecommended, false);
});
