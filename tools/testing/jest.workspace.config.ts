import base from "./jest.source-playback.config.ts";

export default {
  ...base,
  displayName: "workspace",
  testMatch: [
    "<rootDir>/libs/workspace/shell/feature/src/**/*.angular.spec.ts",
  ],
};
