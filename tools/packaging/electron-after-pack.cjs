'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
    validatePackagedEmbeddedMpv,
} = require('./embedded-mpv-packaging.cjs');

function getResourceDir(params) {
    const appPath = params.appOutDir.endsWith('.app')
        ? params.appOutDir
        : fs.readdirSync(params.appOutDir).find((entry) => entry.endsWith('.app'));

    return appPath
        ? path.join(
              params.appOutDir.endsWith('.app')
                  ? params.appOutDir
                  : path.join(params.appOutDir, appPath),
              'Contents',
              'Resources'
          )
        : params.appOutDir;
}

function copyEmbeddedMpvNativeOutput(resourceDir, projectDir) {
    const sourceDir = path.join(
        projectDir,
        'dist',
        'apps',
        'electron-backend',
        'native'
    );

    if (!fs.existsSync(sourceDir)) {
        return;
    }

    const destinationDir = path.join(
        resourceDir,
        'app.asar.unpacked',
        'electron-backend',
        'native'
    );

    fs.rmSync(destinationDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, destinationDir, { recursive: true });

    const helperPath = path.join(destinationDir, 'arm-nator_mpv_helper');
    if (fs.existsSync(helperPath)) {
        fs.chmodSync(helperPath, 0o755);
    }
}

module.exports = async function afterPackHook(params) {
    if (params.electronPlatformName !== 'darwin') {
        throw new Error('This build is configured for macOS only.');
    }

    const resourceDir = getResourceDir(params);
    copyEmbeddedMpvNativeOutput(
        resourceDir,
        params.packager.projectDir ?? process.cwd()
    );

    const required = ['1', 'true', 'yes', 'on'].includes(
        String(process.env.ARM_NATOR_REQUIRE_EMBEDDED_MPV ?? '')
            .trim()
            .toLowerCase()
    );
    const errors = validatePackagedEmbeddedMpv(resourceDir, {
        platform: 'darwin',
        required,
        foreignArch: false,
        executableName: params.packager.executableName,
    });

    if (errors.length > 0) {
        throw new Error(
            ['Embedded MPV macOS package validation failed.', ...errors.map((error) => `- ${error}`)].join('\n')
        );
    }
};
