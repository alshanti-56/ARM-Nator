/* eslint-disable @nx/enforce-module-boundaries */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  FFMPEGKIT_SOURCE,
  FFMPEGKIT_REVISION,
  KSPLAYER_SOURCE,
  KSPLAYER_REVISION,
  parseOtoolRpaths,
  runtimePaths,
  validateKSPlayerMetalRuntime,
} = require("../../tools/packaging/ksplayer-metal-packaging.cjs");

const workspaceRoot = process.cwd();
const packageRoot = path.join(
  workspaceRoot,
  "apps",
  "electron-backend",
  "ksplayer-metal",
);
const nativeRoot = path.join(
  workspaceRoot,
  "apps",
  "electron-backend",
  "native",
);
const outputDir = path.join(nativeRoot, "build", "Release");
const outputPaths = runtimePaths(outputDir);
const swiftBuildRoot = path.join(packageRoot, ".build");
const swiftReleaseDir = path.join(
  swiftBuildRoot,
  "arm64-apple-macosx",
  "release",
);
const ksPlayerPatches = [
  {
    path: path.join(packageRoot, "patches", "ksplayer", "picture-adjustments.patch"),
    files: ["Sources/KSPlayer/MEPlayer/MetalPlayView.swift", "Sources/KSPlayer/Metal/MetalRender.swift", "Sources/KSPlayer/Metal/Shaders.metal"],
    markers: [["Sources/KSPlayer/MEPlayer/MetalPlayView.swift", "setPictureAdjustments"], ["Sources/KSPlayer/Metal/Shaders.metal", "applyPictureAdjustments"]],
  },
  {
    path: path.join(
      packageRoot,
      "patches",
      "ksplayer",
      "in-buffer-backward-seek.patch",
    ),
    files: [
      "Sources/KSPlayer/AVPlayer/KSOptions.swift",
      "Sources/KSPlayer/MEPlayer/MEPlayerItem.swift",
      "Sources/KSPlayer/MEPlayer/Model.swift",
    ],
    markers: [
      ["Sources/KSPlayer/AVPlayer/KSOptions.swift", "backwardSeekBufferDuration"],
      ["Sources/KSPlayer/MEPlayer/MEPlayerItem.swift", "copyForSeekCache"],
      ["Sources/KSPlayer/MEPlayer/MEPlayerItem.swift", "packetHistoryEndTime"],
      ["Sources/KSPlayer/MEPlayer/MEPlayerItem.swift", "Notify callers only after the decoder state and clocks"],
      ["Sources/KSPlayer/MEPlayer/MEPlayerItem.swift", "Keep it after the seek state and clocks are committed"],
    ],
  },
  {
    path: path.join(
      packageRoot,
      "patches",
      "ksplayer",
      "interruptible-network-seek.patch",
    ),
    files: [
      "Sources/KSPlayer/MEPlayer/MEPlayerItem.swift",
    ],
    markers: [
      ["Sources/KSPlayer/MEPlayer/MEPlayerItem.swift", "isPerformingSeek"],
      ["Sources/KSPlayer/MEPlayer/MEPlayerItem.swift", "case .seeking where !formatContext.isPerformingSeek"],
      ["Sources/KSPlayer/MEPlayer/MEPlayerItem.swift", "readResult == AVError.exit.code"],
    ],
  },
  {
    path: path.join(
      packageRoot,
      "patches",
      "ksplayer",
      "precise-seek-timestamp.patch",
    ),
    files: ["Sources/KSPlayer/MEPlayer/MEPlayerItem.swift"],
    markers: [
      [
        "Sources/KSPlayer/MEPlayer/MEPlayerItem.swift",
        "let targetSeconds = seekTime + startTime.seconds",
      ],
      [
        "Sources/KSPlayer/MEPlayer/MEPlayerItem.swift",
        "time.seconds * Double(AV_TIME_BASE)",
      ],
    ],
  },
];
function log(message) {
  process.stdout.write(`[ksplayer-metal] ${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function commandExists(command) {
  return (
    spawnSync("/usr/bin/which", [command], { stdio: "ignore" }).status === 0
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${
        result.status ?? 1
      }${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result.stdout ?? "";
}

function cleanOutput() {
  fs.rmSync(outputPaths.addonPath, { force: true });
  fs.rmSync(outputPaths.manifestPath, { force: true });
  fs.rmSync(outputPaths.runtimeRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 150,
  });
  fs.rmSync(outputPaths.markerPath, { force: true });
    fs.rmSync(
      path.join(nativeRoot, "build", "Release", "obj.target", "ksplayer_metal"),
      {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150,
      },
    );
}

function unavailableOrFail(reason) {
  fail(reason);
}

function assertHost() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return `KSPlayer Metal requires macOS on Apple Silicon; received ${process.platform}-${process.arch}.`;
  }
  return null;
}

function assertBuildTools() {
  const missing = ["swift", "xcodebuild", "xcrun"].filter(
    (command) => !commandExists(command),
  );
  if (missing.length > 0) {
    return `Missing required KSPlayer Metal build tools: ${missing.join(", ")}.`;
  }
  try {
    run("xcodebuild", ["-version"]);
    run("xcrun", ["--sdk", "macosx", "--find", "metal"]);
    run("xcrun", ["--sdk", "macosx", "--find", "metallib"]);
  } catch (error) {
    return `Metal Toolchain probe failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return null;
}

function resolveNodeGypBin() {
  try {
    return require.resolve("node-gyp/bin/node-gyp.js");
  } catch {
    const pnpmRoot = path.join(workspaceRoot, "node_modules", ".pnpm");
    if (fs.existsSync(pnpmRoot)) {
      const candidate = fs
        .readdirSync(pnpmRoot)
        .filter((entry) => entry.startsWith("node-gyp@"))
        .sort()
        .map((entry) =>
          path.join(
            pnpmRoot,
            entry,
            "node_modules",
            "node-gyp",
            "bin",
            "node-gyp.js",
          ),
        )
        .find((entry) => fs.existsSync(entry));
      if (candidate) {
        return candidate;
      }
    }
    throw new Error(
      "Unable to resolve node-gyp required for the KSPlayer Metal addon.",
    );
  }
}

function electronBuildEnvironment() {
  const electronVersion = require(
    path.join(workspaceRoot, "node_modules", "electron", "package.json"),
  ).version;
  return {
    ...process.env,
    npm_config_runtime: "electron",
    npm_config_target: electronVersion,
    npm_config_arch: "arm64",
    npm_config_disturl: "https://electronjs.org/headers",
    npm_config_build_from_source: "true",
    npm_config_update_binary: "false",
    MACOSX_DEPLOYMENT_TARGET: "26.0",
    // binding.gyp has an independently built embedded-MPV target. Leave its
    // optional configure-time values empty while explicitly building only
    // the KSPlayer target, so this lane never links or loads libmpv.
    LIBMPV_INCLUDE_DIR: "",
    LIBMPV_LIBRARY_DIR: "",
  };
}

function runNodeGyp(command, env, additionalArgs = []) {
  run(
    process.execPath,
    [
      resolveNodeGypBin(),
      command,
      "--directory",
      nativeRoot,
      ...additionalArgs,
    ],
    { env, stdio: "inherit" },
  );
}

function readRevision(checkout, expected, name) {
  const revision = run("git", ["-C", checkout, "rev-parse", "HEAD"]).trim();
  if (revision !== expected) {
    fail(`${name} resolved ${revision}; expected exact pin ${expected}.`);
  }
}

function applyKSPlayerPatches(checkout) {
  for (const patchSpec of ksPlayerPatches) {
    if (!fs.existsSync(patchSpec.path)) {
      fail(`Missing maintained KSPlayer patch: ${patchSpec.path}`);
    }
    const patchFiles = patchSpec.files.map((relativePath) =>
      path.join(checkout, relativePath),
    );
    run("/bin/chmod", ["u+w", ...patchFiles]);

    const check = spawnSync(
      "git",
      ["-C", checkout, "apply", "--check", patchSpec.path],
      { encoding: "utf8", stdio: "pipe" },
    );
    if (check.status === 0) {
      run("git", ["-C", checkout, "apply", patchSpec.path], {
        stdio: "inherit",
      });
      log(`Applied maintained KSPlayer patch: ${path.basename(patchSpec.path)}.`);
      continue;
    }

    const reverseCheck = spawnSync(
      "git",
      ["-C", checkout, "apply", "--reverse", "--check", patchSpec.path],
      { encoding: "utf8", stdio: "pipe" },
    );
    if (reverseCheck.status === 0) {
      log(`Maintained KSPlayer patch already applied: ${path.basename(patchSpec.path)}.`);
      continue;
    }

    const markerCheck = patchSpec.markers.every(([relativePath, marker]) =>
      fs.readFileSync(path.join(checkout, relativePath), "utf8").includes(marker),
    );
    if (markerCheck) {
      log(`Maintained KSPlayer patch already included in checkout: ${path.basename(patchSpec.path)}.`);
      continue;
    }

    const detail = [check.stdout, check.stderr, reverseCheck.stdout, reverseCheck.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    fail(`Unable to apply the maintained KSPlayer patch.${detail ? `\n${detail}` : ""}`);
  }
}

function checkouts() {
  const root = path.join(swiftBuildRoot, "checkouts");
  return {
    ksPlayer: path.join(root, "KSPlayer"),
    ffmpegKit: path.join(root, "FFmpegKit"),
  };
}

function compileMetalLibrary(ksPlayerCheckout) {
  const sourcePath = path.join(
    ksPlayerCheckout,
    "Sources",
    "KSPlayer",
    "Metal",
    "Shaders.metal",
  );
  if (!fs.existsSync(sourcePath)) {
    fail(
      `Pinned KSPlayer checkout is missing Metal shader source: ${sourcePath}`,
    );
  }
  const intermediateDir = path.join(swiftBuildRoot, "ksplayer-metal-toolchain");
  const airPath = path.join(intermediateDir, "KSPlayerShaders.air");
  const metallibPath = path.join(intermediateDir, "default.metallib");
  fs.rmSync(intermediateDir, { recursive: true, force: true });
  fs.mkdirSync(intermediateDir, { recursive: true });
  run("xcrun", [
    "--sdk",
    "macosx",
    "metal",
    "-c",
    sourcePath,
    "-mmacosx-version-min=26.0",
    "-o",
    airPath,
  ]);
  run("xcrun", ["--sdk", "macosx", "metallib", airPath, "-o", metallibPath]);
  if (!fs.existsSync(metallibPath) || fs.statSync(metallibPath).size === 0) {
    fail(
      `Metal Toolchain produced an invalid default.metallib: ${metallibPath}`,
    );
  }
  return metallibPath;
}

function addMetalToBundle(bundlePath, sourceBundle, metallibPath) {
  const resources = path.join(bundlePath, "Contents", "Resources");
  fs.mkdirSync(resources, { recursive: true });
  const rootInfo = path.join(sourceBundle, "Info.plist");
  if (fs.existsSync(rootInfo)) {
    fs.copyFileSync(rootInfo, path.join(bundlePath, "Contents", "Info.plist"));
  }
  fs.copyFileSync(metallibPath, path.join(resources, "default.metallib"));
}

function copyBundleWithMetal(sourceBundle, destinationBundle, metallibPath) {
  if (!fs.existsSync(sourceBundle)) {
    fail(`SwiftPM did not produce KSPlayer resource bundle: ${sourceBundle}`);
  }
  fs.rmSync(destinationBundle, { recursive: true, force: true });
  fs.cpSync(sourceBundle, destinationBundle, { recursive: true });
  addMetalToBundle(destinationBundle, sourceBundle, metallibPath);
}

function stageFrameworks() {
  fs.rmSync(outputPaths.frameworkDir, { recursive: true, force: true });
  fs.mkdirSync(outputPaths.frameworkDir, { recursive: true });
  const sourceFrameworks = fs
    .readdirSync(swiftReleaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".framework"))
    .map((entry) => path.join(swiftReleaseDir, entry.name))
    .sort();
  if (sourceFrameworks.length === 0) {
    fail(`SwiftPM produced no FFmpegKit frameworks at ${swiftReleaseDir}.`);
  }
  for (const frameworkPath of sourceFrameworks) {
    if (
      /(?:^|[^a-z])(?:lib)?mpv(?:[^a-z]|$)/i.test(path.basename(frameworkPath))
    ) {
      fail(`Refusing to stage forbidden MPV framework: ${frameworkPath}`);
    }
    fs.cpSync(
      frameworkPath,
      path.join(outputPaths.frameworkDir, path.basename(frameworkPath)),
      {
        recursive: true,
      },
    );
  }
}

function patchDylibRuntimePaths(dylibPath) {
  const rpaths = parseOtoolRpaths(dylibPath);
  for (const rpath of rpaths) {
    if (
      rpath.includes("/Applications/Xcode.app/") ||
      rpath.includes(".xctoolchain/")
    ) {
      run("/usr/bin/install_name_tool", ["-delete_rpath", rpath, dylibPath]);
    }
  }
  const updatedRpaths = parseOtoolRpaths(dylibPath);
  if (!updatedRpaths.includes("@loader_path/Frameworks")) {
    run("/usr/bin/install_name_tool", [
      "-add_rpath",
      "@loader_path/Frameworks",
      dylibPath,
    ]);
  }
  run("/usr/bin/install_name_tool", [
    "-id",
    "@rpath/KSPlayerMetalRuntime.dylib",
    dylibPath,
  ]);
}

function adHocSign(binaryPath) {
  run("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    binaryPath,
  ]);
}

function stageRuntime(ksPlayerCheckout) {
  const sourceDylib = path.join(
    swiftReleaseDir,
    "libKSPlayerMetalRuntime.dylib",
  );
  const sourceBundle = path.join(swiftReleaseDir, "KSPlayer_KSPlayer.bundle");
  if (!fs.existsSync(sourceDylib)) {
    fail(`SwiftPM did not produce KSPlayerMetalRuntime.dylib: ${sourceDylib}`);
  }
  fs.mkdirSync(outputPaths.runtimeRoot, { recursive: true });
  fs.copyFileSync(sourceDylib, outputPaths.dylibPath);
  const metallibPath = compileMetalLibrary(ksPlayerCheckout);
  copyBundleWithMetal(sourceBundle, outputPaths.resourceBundle, metallibPath);
  // Bundle.module points at SwiftPM's build output while developing. Add the
  // compiled library there too; packaged builds use the copied main-bundle
  // resource staged by electron-after-pack.
  addMetalToBundle(sourceBundle, sourceBundle, metallibPath);
  stageFrameworks();
  patchDylibRuntimePaths(outputPaths.dylibPath);
  adHocSign(outputPaths.dylibPath);
}

function writeManifest() {
  const frameworks = fs
    .readdirSync(outputPaths.frameworkDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".framework"))
    .map((entry) => entry.name)
    .sort();
  const manifest = {
    backend: "ksplayer-metal",
    abiVersion: 1,
    platform: "darwin",
    targetArch: "arm64",
    generatedAt: new Date().toISOString(),
    ksPlayer: {
      source: KSPLAYER_SOURCE,
      revision: KSPLAYER_REVISION,
    },
    ffmpegKit: {
      source: FFMPEGKIT_SOURCE,
      revision: FFMPEGKIT_REVISION,
    },
    dylib: path.basename(outputPaths.dylibPath),
    frameworks,
    resourceBundle:
      "KSPlayer_KSPlayer.bundle/Contents/Resources/default.metallib",
    swiftVersion: run("swift", ["--version"]).trim(),
    xcodeVersion: run("xcodebuild", ["-version"]).trim(),
  };
  fs.writeFileSync(
    outputPaths.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function buildAddon() {
  const env = electronBuildEnvironment();
  runNodeGyp("configure", env);
  // Do not invoke node-gyp's default aggregate target: it would build the
  // independently owned embedded MPV target too. The Make target is emitted
  // by this Electron-targeted node-gyp configure step and has no MPV inputs.
  run(
    "/usr/bin/make",
    [
      "-C",
      path.join(nativeRoot, "build"),
      "BUILDTYPE=Release",
      "ksplayer_metal",
    ],
    { env, stdio: "inherit" },
  );
  if (!fs.existsSync(outputPaths.addonPath)) {
    fail(`Electron node-gyp build did not produce ${outputPaths.addonPath}.`);
  }
  adHocSign(outputPaths.addonPath);
}

function main() {
  const hostError = assertHost();
  if (hostError) {
    unavailableOrFail(hostError);
  }
  const toolError = assertBuildTools();
  if (toolError) {
    unavailableOrFail(toolError);
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  cleanOutput();

  try {
    log("Resolving exact SwiftPM dependency pins...");
    run("swift", ["package", "resolve"], {
      cwd: packageRoot,
      stdio: "inherit",
    });
  } catch (error) {
    unavailableOrFail(
      `SwiftPM dependency resolution failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const { ksPlayer, ffmpegKit } = checkouts();
  try {
    readRevision(ksPlayer, KSPLAYER_REVISION, "KSPlayer");
    readRevision(ffmpegKit, FFMPEGKIT_REVISION, "FFmpegKit");
    applyKSPlayerPatches(ksPlayer);
    log("Building the pinned Swift runtime...");
    run("swift", ["build", "--configuration", "release", "--arch", "arm64"], {
      cwd: packageRoot,
      stdio: "inherit",
    });
    stageRuntime(ksPlayer);
    buildAddon();
    writeManifest();
    const validationErrors = validateKSPlayerMetalRuntime(outputDir, {
      platform: "darwin",
      foreignArch: false,
    });
    if (validationErrors.length > 0) {
      fail(validationErrors.join("\n"));
    }
    fs.rmSync(outputPaths.markerPath, { force: true });
  } catch (error) {
    const reason = `KSPlayer Metal build failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    cleanOutput();
    throw new Error(reason);
  }

  log(`Built ${path.relative(workspaceRoot, outputPaths.addonPath)}.`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[ksplayer-metal] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
