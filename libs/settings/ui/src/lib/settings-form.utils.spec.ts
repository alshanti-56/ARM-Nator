import assert from "node:assert/strict";
import { test } from "node:test";
import "@angular/compiler";
import { FormBuilder } from "@angular/forms";
import {
  Language,
  Settings,
  StartupBehavior,
  StreamFormat,
  Theme,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";
import {
  createSettingsForm,
  createSettingsFromFormValue,
} from "./settings-form.utils";

function currentSettings(): Settings {
  return {
    player: VideoPlayer.Auto,
    livePlayer: VideoPlayer.Auto,
    vodPlayer: VideoPlayer.Auto,
    streamFormat: StreamFormat.AutoStreamFormat,
    openStreamOnDoubleClick: false,
    language: Language.ENGLISH,
    showCaptions: false,
    showDashboard: true,
    startupBehavior: StartupBehavior.FirstView,
    theme: Theme.SystemTheme,
    mpvPlayerPath: "",
    mpvPlayerArguments: "",
    mpvReuseInstance: false,
    vlcPlayerPath: "",
    vlcPlayerArguments: "",
    vlcReuseInstance: false,
    trustedInsecureTlsHosts: ["provider.example"],
    tmdb: { enabled: false, apiKey: "existing-api-key" },
  };
}

test("settings serialization defaults media companion off without disturbing other settings", () => {
  const form = createSettingsForm(new FormBuilder());
  const result = createSettingsFromFormValue(form, currentSettings());

  assert.deepEqual(result.mediaCompanion, {
    enabled: false,
    baseUrl: "http://127.0.0.1:4321/",
    allowConversion: false,
  });
  assert.deepEqual(result.trustedInsecureTlsHosts, ["provider.example"]);
  assert.equal(result.tmdb?.apiKey, "");
  assert.ok(!("token" in (result.mediaCompanion ?? {})));
});

test("media companion preferences survive form edits and serialize without session credentials", () => {
  const form = createSettingsForm(new FormBuilder());
  form.patchValue({
    streamFormat: StreamFormat.AutoStreamFormat,
    mediaCompanion: {
      enabled: true,
      baseUrl: "https://companion.example/",
      allowConversion: true,
    },
    tmdb: { apiKey: "user-entered-api-key" },
  });

  const result = createSettingsFromFormValue(form, currentSettings());
  assert.deepEqual(result.mediaCompanion, {
    enabled: true,
    baseUrl: "https://companion.example/",
    allowConversion: true,
  });
  assert.equal(result.openStreamOnDoubleClick, false);
  assert.equal(result.language, Language.ENGLISH);
  assert.equal(result.tmdb?.apiKey, "user-entered-api-key");
});
