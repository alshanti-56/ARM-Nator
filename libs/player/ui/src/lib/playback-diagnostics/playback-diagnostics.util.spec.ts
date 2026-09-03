import assert from "node:assert/strict";
import { test } from "node:test";
import "@angular/compiler";
import {
  classifyMpegTsPlaybackIssue,
  createPlaybackSourceMetadata,
} from "./playback-diagnostics.util";
import { PlaybackDiagnosticCode } from "./playback-diagnostics.model";
import { extractHttpStatusCode } from "./playback-error-patterns.util";
import { isRecoverableMpegTsLiveFailure } from "../web-video-support/mpegts-live-recovery";

const metadata = createPlaybackSourceMetadata({
  url: "http://provider.example/live/1.ts",
  mimeType: "video/mp2t",
});

test("extracts non-standard provider statuses from mpegts payloads", () => {
  assert.equal(
    extractHttpStatusCode(
      "HttpStatusCodeInvalid",
      '{"code":456,"msg":"unknown"}',
      undefined,
    ),
    456,
  );
});

test("does not ask the live recovery loop to replay a provider rejection", () => {
  const issue = classifyMpegTsPlaybackIssue(
    {
      type: "HttpStatusCodeInvalid",
      details: '{"code":458,"msg":"unknown"}',
      info: undefined,
    },
    metadata,
  );

  assert.equal(issue.code, PlaybackDiagnosticCode.ProviderRejected);
  assert.match(issue.details ?? "", /HTTP 458/);
  assert.equal(issue.externalFallbackRecommended, false);
  assert.equal(
    isRecoverableMpegTsLiveFailure(
      "HttpStatusCodeInvalid",
      '{"code":458,"msg":"unknown"}',
      undefined,
    ),
    false,
  );
});

test("keeps transient rate-limit responses on the recoverable path", () => {
  const issue = classifyMpegTsPlaybackIssue(
    {
      type: "HttpStatusCodeInvalid",
      details: '{"code":429,"msg":"busy"}',
      info: undefined,
    },
    metadata,
  );

  assert.notEqual(issue.code, PlaybackDiagnosticCode.ProviderRejected);
  assert.equal(
    isRecoverableMpegTsLiveFailure(
      "HttpStatusCodeInvalid",
      '{"code":429,"msg":"busy"}',
      undefined,
    ),
    true,
  );
});
