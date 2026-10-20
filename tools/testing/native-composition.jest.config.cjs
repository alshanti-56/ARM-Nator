const path = require("node:path");
module.exports = {
  ...require("../../jest.preset.js"),
  rootDir: path.resolve(__dirname, "../.."),
  setupFilesAfterEnv: [
    "<rootDir>/libs/providers/xtream/feature/src/test-setup.ts",
  ],
  testMatch: [
    "<rootDir>/apps/desktop-ui/src/app/browser-guest-host.service.spec.ts",
    "<rootDir>/apps/desktop-ui/src/app/browser-page.component.spec.ts",
    "<rootDir>/apps/desktop-ui/src/app/browser-guest-host.component.spec.ts",
    "<rootDir>/libs/player/ui/src/lib/embedded-mpv-player/native-*.spec.ts",
    "<rootDir>/libs/player/ui/src/lib/player-controls/seek-preview.integration.spec.ts",
  ],
  modulePathIgnorePatterns: ["<rootDir>/dist/", "<rootDir>/.superpowers/"],
  transform: {
    "^.+\\.(ts|js|mjs|html|svg)$": [
      "jest-preset-angular",
      {
        tsconfig: "<rootDir>/libs/providers/xtream/feature/tsconfig.spec.json",
        stringifyContentPathRegex: "\\.(html|svg)$",
      },
    ],
  },
};
