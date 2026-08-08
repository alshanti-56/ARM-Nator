import "@angular/compiler";
import { Injector, signal } from "@angular/core";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { TranslateService } from "@ngx-translate/core";
import { Subject } from "rxjs";
import {
  EmbeddedMpvBackend,
  EmbeddedMpvSupport,
  ResolvedPortalPlayback,
} from "@arm-nator/shared/interfaces";
import { SeriesPlaybackNavigation } from "../portal-inline-player/series-playback-navigation";
import { EmbeddedMpvControlsAdapter } from "./embedded-mpv-controls.adapter";
import { EmbeddedMpvSessionController } from "./embedded-mpv-session-controller";

test("KSPlayer Metal does not advertise frame stepping", () => {
  const backend = signal<EmbeddedMpvBackend>("ksplayer-metal");
  const translateChanges = new Subject<unknown>();
  const controller = {
    activeBackend: backend,
    supportedControls: signal({ pause: true, seek: true, volume: true }),
    support: signal<EmbeddedMpvSupport | null>({
      supported: true,
      platform: "darwin",
      backend: "ksplayer-metal",
    }),
    session: signal(null),
    stalled: signal(false),
  };
  const translate = {
    onLangChange: translateChanges,
    onTranslationChange: translateChanges,
    onDefaultLangChange: translateChanges,
    instant: (key: string) => key,
  };
  const injector = Injector.create({
    providers: [
      { provide: EmbeddedMpvSessionController, useValue: controller },
      { provide: TranslateService, useValue: translate },
      EmbeddedMpvControlsAdapter,
    ],
  });
  const playback = signal<ResolvedPortalPlayback>({
    streamUrl: "https://example.invalid/video",
    title: "Frame-step fixture",
    isLive: false,
  });
  const seriesNavigation = signal<SeriesPlaybackNavigation | null>(null);
  const adapter = injector.get(EmbeddedMpvControlsAdapter);
  adapter.configure({ playback, seriesNavigation });

  assert.equal(adapter.capabilities().frameStep, false);

  backend.set("embedded-mpv");
  assert.equal(adapter.capabilities().frameStep, true);

  playback.update((value) => ({ ...value, isLive: true }));
  assert.equal(adapter.capabilities().frameStep, false);

  injector.destroy();
});
