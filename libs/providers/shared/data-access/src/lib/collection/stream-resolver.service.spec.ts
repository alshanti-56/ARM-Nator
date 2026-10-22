import { restoreNodeTestEnvironment } from "./stream-resolver.node-test-env";
import "@angular/compiler";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";
import test, { before } from "node:test";
import {
  createEnvironmentInjector,
  runInInjectionContext,
} from "@angular/core";
import { of } from "rxjs";
import { PlaylistsService, SettingsStore } from "@arm-nator/services";
import type { UnifiedCollectionItem } from "@arm-nator/providers/shared/util";
import type { Playlist } from "@arm-nator/shared/interfaces";
import {
  XtreamApiService,
  XtreamUrlService,
} from "@arm-nator/providers/xtream/data-access";
import { StreamResolverService } from "./stream-resolver.service";

before(restoreNodeTestEnvironment);

const playlist = {
  _id: "mega",
  title: "MegaTV",
  serverUrl: "https://api.example",
  username: "user name",
  password: "secret/value",
  userAgent: "Provider Player",
  referrer: "https://portal.example/",
  origin: "https://portal.example",
} as Playlist;
const item = {
  uid: "mega:42",
  name: "Live channel",
  playlistId: "mega",
  xtreamId: 42,
  sourceType: "xtream",
  logo: "https://images.example/channel.png",
} as UnifiedCollectionItem;

async function resolve(
  getAccountInfo: (credentials: unknown) => Promise<unknown>,
) {
  const injector = createEnvironmentInjector([
    {
      provide: PlaylistsService,
      useValue: { getPlaylistById: () => of(playlist) },
    },
    { provide: SettingsStore, useValue: { streamFormat: () => "m3u8" } },
    { provide: XtreamApiService, useValue: { getAccountInfo } },
    XtreamUrlService,
  ]);
  try {
    const service = runInInjectionContext(
      injector,
      () => new StreamResolverService(),
    );
    return await service.resolvePlayback(item);
  } finally {
    injector.destroy();
  }
}

test("global live collections use authenticated playback metadata and saved headers", async () => {
  let request: unknown;
  const playback = await resolve(async (credentials) => {
    request = credentials;
    return {
      user_info: {
        auth: 1,
        status: "Active",
        allowed_output_formats: ["ts"],
      },
      server_info: {
        url: "media.example",
        server_protocol: "http",
        port: "80",
      },
    };
  });
  assert.equal(
    playback.streamUrl,
    "http://media.example:80/live/user%20name/secret%2Fvalue/42.ts",
  );
  assert.equal(playback.userAgent, "Provider Player");
  assert.equal(playback.referer, "https://portal.example/");
  assert.equal(playback.origin, "https://portal.example");
  assert.equal(playback.title, "Live channel");
  assert.equal(playback.isLive, true);
  const { sourceViewingIdentity } = createRequire(import.meta.url)(
    resolvePath(
      process.cwd(),
      "apps/desktop-ui/src/app/services/source-playback/source-viewing-session.ts",
    ),
  );
  assert.deepEqual(sourceViewingIdentity(playback), {
    sourceId: "mega",
    itemId: "42",
    category: "live",
  });
  assert.equal(playback.requestPolicy?.accountRef, "mega");
  assert.equal(playback.requestPolicy?.portalCredentials, true);
  assert.equal(playback.recovery?.accountRef, "mega");
  assert.equal(
    playback.recovery?.alternateHostUrl,
    "https://api.example/live/user%20name/secret%2Fvalue/42.ts",
  );
  assert.deepEqual(playback.recovery?.formatUrls, {
    mpegts: playback.streamUrl,
  });
  assert.deepEqual(playback.recovery?.savedHeaders, {
    "User-Agent": "Provider Player",
    Referer: "https://portal.example/",
    Origin: "https://portal.example",
  });
  assert.equal(playback.recovery?.portalCredentialsAvailable, undefined);
  assert.deepEqual(request, {
    serverUrl: "https://api.example",
    username: "user name",
    password: "secret/value",
  });
});

test("global live collections retain the imported endpoint without authenticated metadata", async () => {
  for (const response of [
    {
      user_info: { auth: 0 },
      server_info: {
        url: "untrusted.example",
        server_protocol: "http",
        port: "80",
      },
    },
    { user_info: { auth: 1, status: "Active" } },
  ]) {
    const playback = await resolve(async () => response);
    assert.equal(
      playback.streamUrl,
      "https://api.example/live/user%20name/secret%2Fvalue/42.m3u8",
    );
  }
  const playback = await resolve(async () => {
    throw new Error("Account API unavailable");
  });
  assert.equal(playback.recovery?.alternateHostUrl, undefined);
  assert.equal(playback.recovery?.formatUrls, undefined);
});

test("an account API failure does not block an existing global live URL", async () => {
  const playback = await resolve(async () => {
    throw new Error("Account API unavailable");
  });
  assert.equal(
    playback.streamUrl,
    "https://api.example/live/user%20name/secret%2Fvalue/42.m3u8",
  );
});
