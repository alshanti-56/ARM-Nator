import assert from "node:assert/strict";
import test from "node:test";
import { TitlePreferenceCoordinator } from "./title-preference-coordinator";
import type { TitleTrackPreferences } from "./title-track-preferences";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const subtitleSettings = {
  fontSize: 100,
  textColor: "#ffffff",
  backgroundColor: "#000000",
  backgroundOpacity: 70,
  outlineSize: 2,
  position: 90,
  delaySeconds: 0,
};
const state = {
  audioTracks: [
    { id: 7, language: "fr", role: "main" as const, selected: true },
  ],
  subtitleTracks: [],
  subtitlesEnabled: false,
  subtitle: subtitleSettings,
};

test("missing preferred tracks retain defaults without overwriting saved preferences", async () => {
  const saves: TitleTrackPreferences[] = [],
    commands: string[] = [];
  const coordinator = new TitlePreferenceCoordinator<string>({
    load: async () => ({ audio: { language: "en", role: "main" } }),
    save: async (_, patch) => {
      saves.push(patch);
    },
  });
  coordinator.begin("one");
  await turn();
  const controls = {
    audio: (id: number) => commands.push(`audio:${id}`),
    subtitle: (id: number) => commands.push(`subtitle:${id}`),
    settings: () => commands.push("settings"),
  };
  coordinator.observe(state, controls);
  assert.deepEqual(commands, []);
  assert.deepEqual(saves, []);
  coordinator.observe(
    {
      ...state,
      audioTracks: [{ id: 42, language: "eng", role: "main", selected: false }],
    },
    controls,
  );
  assert.deepEqual(commands, ["audio:42"]);
  assert.deepEqual(saves, []);
});

test("only confirmed user selections are persisted; automatic restoration is not a user selection", async () => {
  const saves: TitleTrackPreferences[] = [];
  const coordinator = new TitlePreferenceCoordinator<string>({
    load: async () => ({ subtitle: "off" }),
    save: async (_, patch) => {
      saves.push(patch);
    },
  });
  coordinator.begin("one");
  await turn();
  const controls = {
    audio: () => undefined,
    subtitle: () => coordinator.record({ kind: "subtitle", preference: "off" }),
    settings: () => undefined,
  };
  coordinator.observe({ ...state, subtitlesEnabled: true }, controls);
  assert.deepEqual(saves, []);
  coordinator.record({
    kind: "audio",
    preference: { language: "en", role: "commentary" },
  });
  coordinator.observe(state, controls);
  await turn();
  assert.deepEqual(saves, []);
  coordinator.observe(
    {
      ...state,
      audioTracks: [
        { id: 99, language: "eng", role: "commentary", selected: true },
      ],
    },
    controls,
  );
  await turn();
  assert.deepEqual(saves, [{ audio: { language: "en", role: "commentary" } }]);
});

test("stale preference loads cannot restore tracks in a replacement title", async () => {
  let finish!: (prefs: TitleTrackPreferences) => void;
  let commands = 0;
  const coordinator = new TitlePreferenceCoordinator<string>({
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    save: async () => undefined,
  });
  coordinator.begin("one");
  await turn();
  const oldFinish = finish;
  coordinator.begin(null);
  oldFinish({ audio: { language: "fr", role: "main" } });
  await turn();
  coordinator.observe(state, {
    audio: () => {
      commands++;
    },
    subtitle: () => {
      commands++;
    },
    settings: () => {
      commands++;
    },
  });
  assert.equal(commands, 0);
});

test("user changes made before a delayed preference load are preserved", async () => {
  let finish!: (value: TitleTrackPreferences) => void;
  const patches: TitleTrackPreferences[] = [];
  const coordinator = new TitlePreferenceCoordinator<string>({
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    save: async (_, patch) => {
      patches.push(patch);
    },
  });
  coordinator.begin("one");
  await turn();
  coordinator.record({
    kind: "audio",
    preference: { language: "fr", role: "main" },
  });
  coordinator.observe(state, {});
  await turn();
  finish({ audio: { language: "en", role: "main" } });
  await turn();
  coordinator.observe(state, {
    audio: () => {
      throw new Error("Must retain confirmed user choice");
    },
  });
  assert.deepEqual(patches, [{ audio: { language: "fr", role: "main" } }]);
});
