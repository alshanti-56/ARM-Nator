import { Injector } from "@angular/core";
import {
  PORTAL_DISCOVERY_ADAPTER,
  DiscoverySelectionService,
} from "@arm-nator/providers/shared/util";
import type { DiscoveryVersion } from "@arm-nator/shared/interfaces";
import { UnifiedDiscoveryState } from "./unified-discovery-state.service";
const version = (id: string): DiscoveryVersion => ({
  identity: {
    sourceType: "xtream",
    playlistId: id,
    contentKind: "vod",
    providerItemId: "7",
  },
  providerName: id,
  originalTitle: "Movie",
  categoryId: "1",
  contentType: "movie",
  work: { kind: "movie", title: "Movie", releaseYear: 2020 },
  navigation: ["/workspace/xtreams", id, "vod", "1", "7"],
});
function setup() {
  const adapter = {
    sources: jest
      .fn()
      .mockResolvedValue([{ playlistId: "portal", providerName: "Portal" }]),
    page: jest.fn().mockResolvedValue({ versions: [] }),
    ranking: jest.fn().mockResolvedValue({ sourceOrder: ["b", "a"] }),
  };
  const injector = Injector.create({
    providers: [
      UnifiedDiscoveryState,
      DiscoverySelectionService,
      { provide: PORTAL_DISCOVERY_ADAPTER, useValue: adapter },
    ],
  });
  return {
    adapter,
    injector,
    state: injector.get(UnifiedDiscoveryState),
    selection: injector.get(DiscoverySelectionService),
  };
}
it("typing updates indexed groups without issuing portal searches; only the explicit action submits", async () => {
  const { adapter, injector, state } = setup();
  try {
    await Promise.resolve();
    state.update("Movie", ["movie"], [version("a"), version("b")]);
    state.update("Matrix", ["movie"], []);
    expect(adapter.page).not.toHaveBeenCalled();
    await state.searchPortals();
    expect(adapter.page).toHaveBeenCalledTimes(1);
    expect(adapter.page.mock.calls[0][1]).toBe("Matrix");
  } finally {
    injector.destroy();
  }
});
it("automatic and manual choices resolve only one navigation target without playback probes", async () => {
  const { adapter, injector, state, selection } = setup();
  try {
    const a = version("a"),
      b = version("b");
    state.update("Movie", ["movie"], [a, b]);
    expect(await state.choose(state.groups()[0])).toBe(b);
    expect(selection.selection()?.selected).toBe(b);
    expect(adapter.page).not.toHaveBeenCalled();
    adapter.ranking.mockClear();
    expect(await state.choose(state.groups()[0], a)).toBe(a);
    expect(adapter.ranking).not.toHaveBeenCalled();
  } finally {
    injector.destroy();
  }
});
it("obsolete ranking results cannot navigate after the query changes", async () => {
  const { adapter, injector, state } = setup();
  try {
    let resolve!: (value: unknown) => void;
    adapter.ranking.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    state.update("Movie", ["movie"], [version("a")]);
    const pending = state.choose(state.groups()[0]);
    state.update("Different", ["movie"], []);
    resolve({});
    expect(await pending).toBeNull();
  } finally {
    injector.destroy();
  }
});
it("unavailable optional preference history keeps selection usable and observable", async () => {
  const { adapter, injector, state } = setup();
  try {
    adapter.ranking.mockRejectedValueOnce(new Error("disk unavailable"));
    state.update("Movie", ["movie"], [version("a")]);
    expect(await state.choose(state.groups()[0])).not.toBeNull();
    expect(state.error()).toContain("preferences");
  } finally {
    injector.destroy();
  }
});
