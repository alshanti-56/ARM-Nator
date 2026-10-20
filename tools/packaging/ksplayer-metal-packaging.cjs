"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BACKEND = "ksplayer-metal";
const KSPLAYER_SOURCE = "https://github.com/kingslay/KSPlayer.git";
const FFMPEGKIT_SOURCE = "https://github.com/kingslay/FFmpegKit.git";
const KSPLAYER_REVISION = "5634297a5d762bc32e4fbd538fb8620331fb7a35";
const FFMPEGKIT_REVISION = "c32be9bfb628042737ad3ef622e930c5c7b15954";

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function commandExists(command) {
  return (
    spawnSync("/usr/bin/which", [command], { stdio: "ignore" }).status === 0
  );
}

function parseOtoolDependencies(binaryPath) {
  return run("/usr/bin/otool", ["-L", binaryPath])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter(Boolean);
}

function parseOtoolRpaths(binaryPath) {
  const lines = run("/usr/bin/otool", ["-l", binaryPath]).split("\n");
  const paths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") {
      continue;
    }
    for (
      let cursor = index + 1;
      cursor < Math.min(index + 8, lines.length);
      cursor += 1
    ) {
      const match = lines[cursor].trim().match(/^path (.+) \(offset/);
      if (match) {
        paths.push(match[1]);
        break;
      }
    }
  }
  return paths;
}

function listFrameworks(frameworkDir) {
  if (!fs.existsSync(frameworkDir)) {
    return [];
  }
  return fs
    .readdirSync(frameworkDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".framework"))
    .map((entry) => path.join(frameworkDir, entry.name))
    .sort();
}

function hashDirectory(directoryPath) {
  const hash = crypto.createHash("sha256");

  function hashEntry(entryPath, relativePath) {
    const stat = fs.lstatSync(entryPath);
    if (stat.isDirectory()) {
      hash.update(`directory\0${relativePath}\0`);
      for (const entry of fs.readdirSync(entryPath).sort()) {
        hashEntry(
          path.join(entryPath, entry),
          path.posix.join(relativePath, entry),
        );
      }
      return;
    }
    if (stat.isSymbolicLink()) {
      hash.update(`symlink\0${relativePath}\0${fs.readlinkSync(entryPath)}\0`);
      return;
    }
    if (stat.isFile()) {
      hash.update(`file\0${relativePath}\0${stat.size}\0`);
      hash.update(fs.readFileSync(entryPath));
      return;
    }
    throw new Error(`Unsupported staged framework entry: ${entryPath}`);
  }

  hashEntry(directoryPath, ".");
  return hash.digest("hex");
}

function hasExactJSON(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function frameworkBinaryPath(frameworkPath) {
  const name = path.basename(frameworkPath, ".framework");
  const direct = path.join(frameworkPath, name);
  if (fs.existsSync(direct)) {
    return direct;
  }
  const versions = path.join(frameworkPath, "Versions", "Current", name);
  return fs.existsSync(versions) ? versions : null;
}

function hasArm64Slice(binaryPath) {
  try {
    return run("/usr/bin/lipo", ["-archs", binaryPath])
      .split(/\s+/)
      .includes("arm64");
  } catch {
    return false;
  }
}

function isSystemDependency(dependencyPath) {
  return (
    dependencyPath.startsWith("/System/Library/") ||
    dependencyPath.startsWith("/usr/lib/")
  );
}

function resolveLoaderPath(dependencyPath, binaryPath) {
  if (!dependencyPath.startsWith("@loader_path/")) {
    return null;
  }
  return path.resolve(
    path.dirname(binaryPath),
    dependencyPath.slice("@loader_path/".length),
  );
}

function containsMpv(value) {
  return /(?:^|[^a-z])(?:lib)?mpv(?:[^a-z]|$)|embedded[_-]?mpv/i.test(value);
}

function runtimePaths(nativeDir) {
  const runtimeRoot = path.join(nativeDir, BACKEND);
  return {
    nativeDir,
    addonPath: path.join(nativeDir, "ksplayer_metal.node"),
    markerPath: path.join(nativeDir, "ksplayer-metal-unavailable.txt"),
    manifestPath: path.join(nativeDir, "ksplayer-metal-runtime.json"),
    runtimeRoot,
    dylibPath: path.join(runtimeRoot, "KSPlayerMetalRuntime.dylib"),
    frameworkDir: path.join(runtimeRoot, "Frameworks"),
    resourceBundle: path.join(runtimeRoot, "KSPlayer_KSPlayer.bundle"),
    metallibPath: path.join(
      runtimeRoot,
      "KSPlayer_KSPlayer.bundle",
      "Contents",
      "Resources",
      "default.metallib",
    ),
  };
}

function validateRuntimeDependencies(binaryPath, expectedFrameworkDir) {
  const errors = [];
  const dependencies = parseOtoolDependencies(binaryPath);
  for (const [index, dependencyPath] of dependencies.entries()) {
    // A dylib reports its own LC_ID_DYLIB as the first `otool -L` line.
    // It is an identity, not a load-time dependency, so it cannot and
    // should not be resolved out of the staged framework directory.
    if (
      index === 0 &&
      path.basename(binaryPath) === "KSPlayerMetalRuntime.dylib" &&
      dependencyPath === "@rpath/KSPlayerMetalRuntime.dylib"
    ) {
      continue;
    }
    if (containsMpv(dependencyPath)) {
      errors.push(
        `${binaryPath} has a forbidden MPV dependency: ${dependencyPath}`,
      );
      continue;
    }
    if (isSystemDependency(dependencyPath)) {
      continue;
    }
    if (dependencyPath.startsWith("@loader_path/")) {
      const resolved = resolveLoaderPath(dependencyPath, binaryPath);
      if (!resolved || !fs.existsSync(resolved)) {
        errors.push(
          `${binaryPath} has a missing loader-relative dependency: ${dependencyPath}`,
        );
      }
      continue;
    }
    if (dependencyPath.startsWith("@rpath/")) {
      const dependencyName = path.basename(dependencyPath);
      if (dependencyName.startsWith("libswift")) {
        continue;
      }
      const rpathCandidates = parseOtoolRpaths(binaryPath)
        .filter((rpath) => rpath.startsWith("@loader_path/"))
        .map((rpath) =>
          path.resolve(
            path.dirname(binaryPath),
            rpath.slice("@loader_path/".length),
            dependencyName,
          ),
        );
      if (!rpathCandidates.some((candidate) => fs.existsSync(candidate))) {
        errors.push(
          `${binaryPath} has an unresolved rpath dependency: ${dependencyPath}`,
        );
      }
      continue;
    }
    errors.push(
      `${binaryPath} has a non-system absolute dependency: ${dependencyPath}`,
    );
  }

  const rpaths = parseOtoolRpaths(binaryPath);
  if (!rpaths.includes("@loader_path/Frameworks")) {
    errors.push(
      `${binaryPath} is missing the @loader_path/Frameworks runtime path.`,
    );
  }
  for (const rpath of rpaths) {
    if (
      rpath.includes("/Applications/Xcode.app/") ||
      rpath.includes(".xctoolchain/")
    ) {
      errors.push(
        `${binaryPath} retains a developer-toolchain rpath: ${rpath}`,
      );
    }
  }
  if (!fs.existsSync(expectedFrameworkDir)) {
    errors.push(
      `Missing staged FFmpegKit framework directory: ${expectedFrameworkDir}`,
    );
  }
  return errors;
}

function validateKSPlayerMetalRuntime(nativeDir, options = {}) {
  const paths = runtimePaths(nativeDir);
  const errors = [];
  if (options.platform && options.platform !== "darwin") {
    errors.push("KSPlayer Metal packaging supports darwin only.");
  }
  if (
    !options.foreignArch &&
    (process.platform !== "darwin" || process.arch !== "arm64")
  ) {
    errors.push("KSPlayer Metal validation requires macOS on Apple Silicon.");
  }
  for (const artifact of [
    paths.addonPath,
    paths.manifestPath,
    paths.dylibPath,
    paths.metallibPath,
  ]) {
    if (!fs.existsSync(artifact)) {
      errors.push(`Missing KSPlayer Metal artifact: ${artifact}`);
    }
  }
  if (fs.existsSync(paths.markerPath)) {
    errors.push(
      `KSPlayer Metal has an unavailable marker instead of a runtime: ${paths.markerPath}`,
    );
  }

  if (fs.existsSync(paths.manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf8"));
      if (manifest.backend !== BACKEND || manifest.abiVersion !== 1) {
        errors.push(
          "KSPlayer Metal runtime manifest has an incompatible backend or ABI version.",
        );
      }
      if (manifest.platform !== "darwin" || manifest.targetArch !== "arm64") {
        errors.push(
          "KSPlayer Metal runtime manifest must target darwin-arm64.",
        );
      }
      if (
        manifest.ksPlayer?.revision !== KSPLAYER_REVISION ||
        manifest.ffmpegKit?.revision !== FFMPEGKIT_REVISION
      ) {
        errors.push(
          "KSPlayer Metal runtime manifest does not retain the exact audited source pins.",
        );
      }
      const expectedFrameworkNames = listFrameworks(paths.frameworkDir).map(
        (frameworkPath) => path.basename(frameworkPath),
      );
      if (!hasExactJSON(manifest.frameworks, expectedFrameworkNames)) {
        errors.push(
          "KSPlayer Metal runtime manifest does not match the staged framework inventory.",
        );
      }
    } catch (error) {
      errors.push(
        `Invalid KSPlayer Metal runtime manifest: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const binaryPath of [paths.addonPath, paths.dylibPath]) {
    if (fs.existsSync(binaryPath) && !hasArm64Slice(binaryPath)) {
      errors.push(`KSPlayer Metal binary is not arm64: ${binaryPath}`);
    }
    if (fs.existsSync(binaryPath) && containsMpv(binaryPath)) {
      errors.push(
        `KSPlayer Metal artifact name must not reference MPV: ${binaryPath}`,
      );
    }
  }
  if (fs.existsSync(paths.dylibPath)) {
    errors.push(
      ...validateRuntimeDependencies(paths.dylibPath, paths.frameworkDir),
    );
  }
  if (fs.existsSync(paths.addonPath)) {
    for (const dependencyPath of parseOtoolDependencies(paths.addonPath)) {
      if (containsMpv(dependencyPath)) {
        errors.push(
          `${paths.addonPath} has a forbidden MPV dependency: ${dependencyPath}`,
        );
      }
    }
    if (
      !parseOtoolRpaths(paths.addonPath).includes(`@loader_path/${BACKEND}`)
    ) {
      errors.push(
        `${paths.addonPath} is missing the @loader_path/${BACKEND} runtime path.`,
      );
    }
  }

  const frameworks = listFrameworks(paths.frameworkDir);
  if (frameworks.length === 0) {
    errors.push(
      `No FFmpegKit frameworks were staged in ${paths.frameworkDir}.`,
    );
  }
  for (const frameworkPath of frameworks) {
    if (containsMpv(path.basename(frameworkPath))) {
      errors.push(
        `Forbidden MPV framework staged in KSPlayer runtime: ${frameworkPath}`,
      );
      continue;
    }
    const binaryPath = frameworkBinaryPath(frameworkPath);
    if (!binaryPath) {
      errors.push(`Unable to locate framework binary: ${frameworkPath}`);
    } else if (!hasArm64Slice(binaryPath)) {
      errors.push(`Framework is missing an arm64 slice: ${binaryPath}`);
    }
  }

  return errors;
}

function validatePackagedKSPlayerMetal(resourceDir, options = {}) {
  const nativeDir = path.join(
    resourceDir,
    "app.asar.unpacked",
    "electron-backend",
    "native",
  );
  const errors = validateKSPlayerMetalRuntime(nativeDir, options);
  if (options.appPath) {
    const legacyRootBundle = path.join(
      options.appPath,
      "KSPlayer_KSPlayer.bundle",
    );
    const mainBundle = path.join(resourceDir, "KSPlayer_KSPlayer.bundle");
    const mainMetallib = path.join(
      mainBundle,
      "Contents",
      "Resources",
      "default.metallib",
    );
    const defaultMetallib = path.join(resourceDir, "default.metallib");
    if (!fs.existsSync(mainMetallib)) {
      errors.push(
        `Missing main-bundle KSPlayer resource bundle: ${mainMetallib}`,
      );
    }
    if (!fs.existsSync(defaultMetallib)) {
      errors.push(
        `Missing main-bundle default Metal library: ${defaultMetallib}`,
      );
    }
    if (fs.existsSync(legacyRootBundle)) {
      errors.push(
        `KSPlayer resource bundle must not be staged at the app root: ${legacyRootBundle}`,
      );
    }
  }
  return errors;
}

function stageKSPlayerMetalMainBundleResources(resourceDir, appPath, sourceNativeDir) {
  const nativeDir = sourceNativeDir ?? path.join(
    resourceDir,
    "app.asar.unpacked",
    "electron-backend",
    "native",
  );
  const paths = runtimePaths(nativeDir);
  if (
    !fs.existsSync(paths.resourceBundle) ||
    !fs.existsSync(paths.metallibPath)
  ) {
    throw new Error(
      "Cannot stage KSPlayer Metal resources before the runtime is copied.",
    );
  }
  // Keep SwiftPM's resource bundle inside Contents/Resources so it is sealed
  // as an ordinary macOS app resource. `default.metallib` is also copied to
  // the resource root, which is where MTLDevice.makeDefaultLibrary() looks.
  const destinationBundle = path.join(resourceDir, "KSPlayer_KSPlayer.bundle");
  // Remove artifacts emitted by an earlier layout before signing. App roots
  // cannot seal arbitrary resource bundles, which makes a stale root copy a
  // hard packaging failure under hardened runtime.
  if (appPath) {
    fs.rmSync(path.join(appPath, "KSPlayer_KSPlayer.bundle"), {
      recursive: true,
      force: true,
    });
  }
  fs.rmSync(destinationBundle, { recursive: true, force: true });
  fs.cpSync(paths.resourceBundle, destinationBundle, { recursive: true });
  fs.copyFileSync(
    paths.metallibPath,
    path.join(resourceDir, "default.metallib"),
  );
}

module.exports = {
  BACKEND,
  FFMPEGKIT_SOURCE,
  FFMPEGKIT_REVISION,
  KSPLAYER_SOURCE,
  KSPLAYER_REVISION,
  commandExists,
  frameworkBinaryPath,
  hasArm64Slice,
  hashDirectory,
  listFrameworks,
  parseOtoolDependencies,
  parseOtoolRpaths,
  runtimePaths,
  stageKSPlayerMetalMainBundleResources,
  validateKSPlayerMetalRuntime,
  validatePackagedKSPlayerMetal,
};
