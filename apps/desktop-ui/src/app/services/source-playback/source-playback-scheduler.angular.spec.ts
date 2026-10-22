import { TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import { Store } from "@ngrx/store";
import { PlaybackResourceService } from "@arm-nator/player/ui";
import { SourcePlaybackStoreService } from "@arm-nator/services";
import { SourcePlaybackSchedulerService } from "./source-playback-scheduler.service";
import { SourcePlaybackCheckService } from "./source-playback-check.service";
describe("native source scheduling integration", () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    jest.useRealTimers();
  });
  it("starts at ten seconds, resets idle after occupancy and advances after a slow source", () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const sources = signal(
      ["a", "b"].map((_id) => ({
        _id,
        serverUrl: "https://fixture.test",
        username: "x",
        password: "y",
      })),
    );
    const occupied = signal(false);
    const activity = signal<any>({ state: "idle" });
    const snapshots = signal(
      new Map(
        ["a", "b"].map((sourceId) => [
          sourceId,
          {
            sourceId,
            revision: "r",
            nextEligibleAt: {},
            inconclusiveCounts: {},
          },
        ]),
      ),
    );
    const runCheck = jest.fn(() => {
      activity.set({ state: "checking" });
      return Promise.resolve();
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: Store, useValue: { selectSignal: () => sources } },
        {
          provide: PlaybackResourceService,
          useValue: { isBlocked: () => occupied() },
        },
        {
          provide: SourcePlaybackStoreService,
          useValue: {
            snapshots,
            load: jest.fn(async () => {
              /* Test double intentionally has no side effects. */
            }),
          },
        },
        {
          provide: SourcePlaybackCheckService,
          useValue: {
            available: () => true,
            activity,
            supportedCategories: () => ["live"],
            providerDue: () => new Map(),
            busySourceIds: new Set(),
            setSources: jest.fn(),
            retainKeys: jest.fn(),
            runCheck,
          },
        },
      ],
    });
    const scheduler = TestBed.inject(SourcePlaybackSchedulerService);
    TestBed.runInInjectionContext(() => scheduler.start());
    TestBed.tick();
    jest.advanceTimersByTime(9999);
    TestBed.tick();
    expect(runCheck).not.toHaveBeenCalled();
    occupied.set(true);
    TestBed.tick();
    jest.advanceTimersByTime(10000);
    TestBed.tick();
    expect(runCheck).not.toHaveBeenCalled();
    occupied.set(false);
    TestBed.tick();
    jest.advanceTimersByTime(10000);
    TestBed.tick();
    expect(runCheck.mock.calls[0][0].sourceId).toBe("a");
    jest.advanceTimersByTime(70000);
    activity.set({ state: "idle" });
    TestBed.tick();
    expect(runCheck.mock.calls[1][0].sourceId).toBe("b");
  });
});
