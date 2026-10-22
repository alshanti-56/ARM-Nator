import { signal } from "@angular/core";
import { of } from "rxjs";
import { PlaybackResourceService } from "@arm-nator/player/ui";
import { SourcePlaybackCheckService } from "./source-playback-check.service";
import { SourceCheckQueue } from "./source-check-queue";
for (const recovery of ["foreground", "source edit"])
  it("retries a rejected check drain for " + recovery, async () => {
    const resources = new PlaybackResourceService();
    let failures = 1;
    const checks = Object.assign(
      Object.create(SourcePlaybackCheckService.prototype),
      {
        available: () => true,
        running: false,
        queue: new SourceCheckQueue(),
        busyVersion: signal(0),
        providers: new Map(),
        queueChanged: signal(0),
        activity: signal({ state: "idle" }),
        resources,
        probe: {
          drain: async () => {
            if (failures-- > 0) throw Error("Temporary cleanup failure");
          },
        },
        playlists: { getPlaylistById: () => of(null) },
        repository: { write: async () => "saved" },
        store: {
          snapshots: () => new Map(),
          refreshSaved: async () => undefined,
          persistenceFailure: signal(null),
        },
      },
    );
    await checks.runCheck(
      { sourceId: "one", revision: "r", category: "live" },
      "manual",
      new AbortController().signal,
    );
    expect(resources.isBlocked()).toBe(true);
    const foreground = jest.fn(async () => undefined);
    if (recovery === "foreground") await resources.withForeground(foreground);
    else {
      const release = await checks.beginSourceOperation("one");
      release();
      foreground();
    }
    expect(foreground).toHaveBeenCalledTimes(1);
    expect(resources.isBlocked()).toBe(false);
  });
