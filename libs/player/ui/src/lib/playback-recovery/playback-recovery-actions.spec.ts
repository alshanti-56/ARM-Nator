import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecoveryActions,
  applyRecoveryAction,
} from "./playback-recovery-actions";
const source = { streamUrl: "https://media.example/live.m3u8", title: "Live" };
test("all actions remain visible without provider capabilities", () => {
  const actions = buildRecoveryActions({
    playback: source,
    canResolve: false,
    proxyAvailable: false,
    loginCookies: false,
    portalCredentials: false,
    drmAvailable: false,
    engines: [],
  });
  assert.equal(actions.length, 15);
  assert.equal(actions[0].id, "retry");
  assert.equal(actions.find((a) => a.id === "fresh-link")?.enabled, false);
  assert.ok(actions.filter((a) => !a.enabled).every((a) => a.reasonKey));
});
test("HTTP evidence suggests refresh but opaque browser status never does", () => {
  const options = {
    playback: source,
    canResolve: true,
    proxyAvailable: true,
    loginCookies: false,
    portalCredentials: false,
    drmAvailable: false,
    engines: [],
  };
  assert.equal(
    buildRecoveryActions({
      ...options,
      network: { status: 403, resourceKind: "segment" },
    })[0].id,
    "fresh-link",
  );
  assert.equal(
    buildRecoveryActions({
      ...options,
      network: { status: null, resourceKind: "unknown" },
    })[0].id,
    "retry",
  );
  assert.equal(
    buildRecoveryActions({
      ...options,
      network: { status: 403, resourceKind: "license" },
    })[0].id,
    "retry",
  );
});
test("each action uses baseline headers and clears earlier experimental policies", () => {
  const baseline = {
    ...source,
    headers: { Cookie: "normal" },
    recovery: {
      accountRef: "account",
      defaultHeaders: { "User-Agent": "default" },
    },
    requestPolicy: { loginCookies: true },
  };
  const direct = applyRecoveryAction(baseline, "default-headers");
  assert.deepEqual(direct.headers, {
    Cookie: "normal",
    "User-Agent": "default",
  });
  assert.equal(direct.requestPolicy, undefined);
  assert.equal(
    applyRecoveryAction(baseline, "login-cookies").requestPolicy?.accountRef,
    "account",
  );
  assert.equal(applyRecoveryAction(baseline, "retry").requestPolicy, undefined);
});

test("changing the presentation header profile retains normal media authentication", () => {
  const playback = {
    ...source,
    headers: {
      Authorization: "Bearer normal",
      Cookie: "normal-cookie",
      "User-Agent": "saved",
    },
    recovery: { defaultHeaders: { "User-Agent": "default" } },
  };
  const result = applyRecoveryAction(playback, "default-headers");
  assert.equal(result.headers?.Authorization, "Bearer normal");
  assert.equal(result.headers?.Cookie, "normal-cookie");
  assert.equal(result.headers?.["User-Agent"], "default");
});

test("header actions are disabled when effective profiles already match", () => {
  const playback = {
    ...source,
    userAgent: "Provider",
    headers: { Cookie: "normal", Referer: "https://portal.example" },
    recovery: {
      savedHeaders: {
        "User-Agent": "Provider",
        Referer: "https://portal.example",
      },
      defaultHeaders: {
        Referer: "https://portal.example",
        "User-Agent": "Provider",
      },
    },
  };
  const options = {
    playback,
    canResolve: false,
    proxyAvailable: true,
    loginCookies: false,
    portalCredentials: false,
    drmAvailable: false,
    engines: [],
  };
  const actions = buildRecoveryActions(options);
  assert.equal(actions.find((a) => a.id === "saved-headers")?.enabled, false);
  assert.equal(actions.find((a) => a.id === "default-headers")?.enabled, false);
});
