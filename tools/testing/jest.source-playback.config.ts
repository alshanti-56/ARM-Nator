import type { Config } from "jest";
const config: Config = {
  displayName: "source-playback",
  rootDir: "../..",
  preset: "<rootDir>/jest.preset.js",
  testEnvironment: "jsdom",
  modulePathIgnorePatterns: ["<rootDir>/dist/", "<rootDir>/.superpowers/"],
  testMatch: [
    "<rootDir>/libs/providers/shared/playlist-ui/src/lib/recent-playlists/source-playback-details/*.spec.ts",
    "<rootDir>/libs/workspace/shell/feature/src/lib/workspace-sources-filters-panel/source-playback-filters.component.spec.ts",
  ],
  setupFilesAfterEnv: [
    "<rootDir>/libs/providers/stalker/feature/src/test-setup.ts",
  ],
  transform: {
    "^.+\\.(ts|mjs|js|html)$": [
      "jest-preset-angular",
      {
        tsconfig: "<rootDir>/tools/testing/tsconfig.source-playback.json",
        stringifyContentPathRegex: "\\.(html|svg)$",
      },
    ],
  },
};
export default config;
