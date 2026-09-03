const path = require('node:path');

const nativeBuildDirectory = path.resolve(
    __dirname,
    '../../apps/electron-backend/native/build'
);

/**
 * Keep native-player build churn out of the Electron development watcher.
 * Native players are built explicitly by `pnpm dev:native`; changing one
 * binary must not restart the whole desktop app while TypeScript is running.
 */
module.exports = (config) => ({
    ...config,
    watchOptions: {
        ...(config.watchOptions ?? {}),
        aggregateTimeout: 300,
        ignored: [
            ...(Array.isArray(config.watchOptions?.ignored)
                ? config.watchOptions.ignored
                : config.watchOptions?.ignored
                  ? [config.watchOptions.ignored]
                  : []),
            nativeBuildDirectory
        ]
    }
});
