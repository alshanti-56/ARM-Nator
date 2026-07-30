'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validatePackagedEmbeddedMpv } = require('./embedded-mpv-packaging.cjs');

function getAppPath(params) {
    const appName = params.appOutDir.endsWith('.app')
        ? params.appOutDir
        : fs
              .readdirSync(params.appOutDir)
              .find((entry) => entry.endsWith('.app'));

    return params.appOutDir.endsWith('.app')
        ? params.appOutDir
        : appName
          ? path.join(params.appOutDir, appName)
          : null;
}

function getResourceDir(params) {
    const appPath = getAppPath(params);

    return appPath
        ? path.join(appPath, 'Contents', 'Resources')
        : params.appOutDir;
}

function adHocSignApp(params) {
    const enabled = ['1', 'true', 'yes', 'on'].includes(
        String(process.env.ARM_NATOR_ADHOC_SIGN ?? '')
            .trim()
            .toLowerCase()
    );
    if (!enabled) {
        return;
    }

    const appPath = getAppPath(params);
    if (!appPath) {
        throw new Error(
            `Unable to locate the macOS app bundle under ${params.appOutDir}.`
        );
    }

    execFileSync(
        '/usr/bin/codesign',
        [
            '--force',
            '--deep',
            '--sign',
            '-',
            '--options',
            'runtime',
            '--entitlements',
            path.join(
                params.packager.projectDir ?? process.cwd(),
                'apps',
                'electron-backend',
                'macos',
                'entitlements.mac.plist'
            ),
            appPath
        ],
        { stdio: 'inherit' }
    );
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

    const errors = validatePackagedEmbeddedMpv(resourceDir, {
        platform: 'darwin',
        required: true,
        foreignArch: false,
        executableName: params.packager.executableName
    });

    if (errors.length > 0) {
        throw new Error(
            [
                'Embedded MPV macOS package validation failed.',
                ...errors.map((error) => `- ${error}`)
            ].join('\n')
        );
    }

    adHocSignApp(params);
};
