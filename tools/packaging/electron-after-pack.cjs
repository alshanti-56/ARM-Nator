'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validatePackagedEmbeddedMpv } = require('./embedded-mpv-packaging.cjs');
const {
    stageKSPlayerMetalMainBundleResources,
    validatePackagedKSPlayerMetal
} = require('./ksplayer-metal-packaging.cjs');

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
    const ffmpegPath = path.join(destinationDir, 'ffmpeg');
    if (fs.existsSync(ffmpegPath)) {
        fs.chmodSync(ffmpegPath, 0o755);
    }
}

module.exports = async function afterPackHook(params) {
    if (params.electronPlatformName !== 'darwin') {
        throw new Error('This build is configured for macOS only.');
    }

    const resourceDir = getResourceDir(params);
    const appPath = getAppPath(params);
    copyEmbeddedMpvNativeOutput(
        resourceDir,
        params.packager.projectDir ?? process.cwd()
    );

    if (!appPath) {
        throw new Error(
            `Unable to locate the macOS app bundle under ${params.appOutDir}.`
        );
    }
    // Keep both KSPlayer resources in Contents/Resources. The Swift runtime
    // verifies the default library before creating a Metal view, avoiding the
    // generated SwiftPM accessor's build-tree fallback in packaged builds.
    stageKSPlayerMetalMainBundleResources(resourceDir, appPath);

    const errors = [
        ...validatePackagedEmbeddedMpv(resourceDir, {
            platform: 'darwin',
            required: true,
            foreignArch: false,
            executableName: params.packager.executableName
        }),
        ...validatePackagedKSPlayerMetal(resourceDir, {
            platform: 'darwin',
            foreignArch: false,
            appPath
        })
    ];

    if (errors.length > 0) {
        throw new Error(
            [
                'Native macOS player package validation failed.',
                ...errors.map((error) => `- ${error}`)
            ].join('\n')
        );
    }

    adHocSignApp(params);
};
