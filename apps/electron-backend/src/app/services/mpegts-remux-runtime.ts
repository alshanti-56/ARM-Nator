import { accessSync, constants } from "node:fs";
import path from "node:path";

function dedupe(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((value): value is string => Boolean(value)))];
}

function isPackagedElectronProcess(): boolean {
  const electronProcess = process as NodeJS.Process & {
    defaultApp?: boolean;
    resourcesPath?: string;
  };
  return Boolean(electronProcess.resourcesPath && !electronProcess.defaultApp);
}

export function getMpegTsRemuxerCandidatePaths(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const bundled = dedupe([
    process.env.ARM_NATOR_FFMPEG_PATH,
    path.resolve(
      process.cwd(),
      "apps/electron-backend/native/build/Release/ffmpeg",
    ),
    path.resolve(__dirname, "native/ffmpeg"),
    path.resolve(__dirname, "../../native/ffmpeg"),
    resourcesPath
      ? path.resolve(
          resourcesPath,
          "app.asar.unpacked",
          "electron-backend",
          "native",
          "ffmpeg",
        )
      : undefined,
  ]);

  if (isPackagedElectronProcess()) {
    return bundled;
  }

  return dedupe([
    ...bundled,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ]);
}

export function resolveMpegTsRemuxerPath(): string | null {
  for (const candidate of getMpegTsRemuxerCandidatePaths()) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next bundled or development candidate.
    }
  }
  return null;
}
