import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { getArmNatorDataRoot } from "@arm-nator/database/path-utils";

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_ARCHIVE_COUNT = 2;
const DEFAULT_MAX_QUEUED_RECORDS = 256;
const MAX_ERROR_CAUSE_DEPTH = 5;
const MAX_ERROR_TEXT_LENGTH = 8 * 1024;

export type PlaybackDiagnosticHeaders = Record<string, string | string[]>;

export interface PlaybackDiagnosticInput {
  event: string;
  requestId?: string;
  sourceUrl?: string;
  requestUrl?: string;
  responseUrl?: string;
  requestHeaders?: PlaybackDiagnosticHeaders;
  responseHeaders?: PlaybackDiagnosticHeaders;
  status?: number;
  durationMs?: number;
  sessionId?: string;
  resourceId?: string;
  phase?: string;
  transport?: string;
  resourceKind?: string;
  activeSessions?: number;
  error?: unknown;
  operation?: string;
  providerAuth?: unknown;
  providerActiveConnections?: number;
  providerMaxConnections?: number;
  state?: string;
  details?: string;
}

export interface PlaybackDiagnosticsStoreOptions {
  filePath?: string;
  maxBytes?: number;
  maxArchives?: number;
  maxQueuedRecords?: number;
  maxQueuedBytes?: number;
}

export function getDefaultPlaybackDiagnosticsPath(): string {
  return join(getArmNatorDataRoot(), "logs", "playback-diagnostics.jsonl");
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function errorRecord(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): unknown {
  if (value == null) return value;
  if (depth >= MAX_ERROR_CAUSE_DEPTH) return "[Cause depth limit]";
  if (typeof value !== "object") {
    return {
      name: "Error",
      message: String(value).slice(0, MAX_ERROR_TEXT_LENGTH),
    };
  }
  if (seen.has(value)) return "[Circular cause]";
  seen.add(value);
  const source = value as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    cause?: unknown;
  };
  const result: Record<string, unknown> = {
    name:
      typeof source.name === "string"
        ? source.name.slice(0, 256)
        : value instanceof Error
          ? value.name
          : "Error",
    message:
      typeof source.message === "string"
        ? source.message.slice(0, MAX_ERROR_TEXT_LENGTH)
        : String(value).slice(0, MAX_ERROR_TEXT_LENGTH),
  };
  if (typeof source.code === "string" || typeof source.code === "number") {
    result.code = source.code;
  }
  if (source.cause !== undefined) {
    result.cause = errorRecord(source.cause, seen, depth + 1);
  }
  return result;
}

function jsonSafe(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Error) return errorRecord(item);
      if (item && typeof item === "object") {
        if (ancestors.has(item)) return "[Circular]";
        ancestors.add(item);
      }
      return item;
    }),
  );
}

function snapshot(input: PlaybackDiagnosticInput): string {
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    event:
      typeof input?.event === "string"
        ? input.event
        : "diagnostic-record-invalid",
  };
  const fields: (keyof PlaybackDiagnosticInput)[] = [
    "event",
    "requestId",
    "sourceUrl",
    "requestUrl",
    "responseUrl",
    "requestHeaders",
    "responseHeaders",
    "status",
    "durationMs",
    "sessionId",
    "resourceId",
    "phase",
    "transport",
    "resourceKind",
    "activeSessions",
    "error",
    "operation",
    "providerAuth",
    "providerActiveConnections",
    "providerMaxConnections",
    "state",
    "details",
  ];
  for (const field of fields) {
    const value = input?.[field];
    if (value === undefined) continue;
    record[field] = field === "error" ? errorRecord(value) : jsonSafe(value);
  }
  return JSON.stringify(record) + "\n";
}

export class PlaybackDiagnosticsStore {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxArchives: number;
  private readonly maxQueuedRecords: number;
  private readonly maxQueuedBytes: number;
  private readonly queue: { line: string; bytes: number }[] = [];
  private activeRecord: { line: string; bytes: number } | null = null;
  private queuedBytes = 0;
  private drainPromise: Promise<void> | null = null;
  private writeFailed = false;
  private writeFailureReported = false;
  private queueOverflowReported = false;
  private oversizedRecordReported = false;

  constructor(options: PlaybackDiagnosticsStoreOptions = {}) {
    this.filePath = options.filePath ?? getDefaultPlaybackDiagnosticsPath();
    this.maxBytes = normalizePositiveInteger(
      options.maxBytes,
      DEFAULT_MAX_FILE_BYTES,
    );
    const maxArchives = options.maxArchives;
    this.maxArchives = Math.max(
      0,
      typeof maxArchives === "number" && Number.isSafeInteger(maxArchives)
        ? maxArchives
        : DEFAULT_ARCHIVE_COUNT,
    );
    this.maxQueuedRecords = normalizePositiveInteger(
      options.maxQueuedRecords,
      DEFAULT_MAX_QUEUED_RECORDS,
    );
    this.maxQueuedBytes = normalizePositiveInteger(
      options.maxQueuedBytes,
      this.maxBytes,
    );
  }

  record(input: PlaybackDiagnosticInput): void {
    if (this.writeFailed) return;
    try {
      this.enqueueLine(snapshot(input));
    } catch {
      try {
        this.enqueueLine(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            event: "diagnostic-record-invalid",
          }) + "\n",
        );
      } catch {
        // Diagnostics must never affect a playback request.
      }
    }
  }

  async flush(): Promise<void> {
    while (
      !this.writeFailed &&
      (this.drainPromise || this.queue.length > 0 || this.activeRecord)
    ) {
      if (!this.drainPromise) this.startDrain();
      const activeDrain = this.drainPromise;
      if (activeDrain) await activeDrain;
    }
  }

  private startDrain(): void {
    if (this.drainPromise || this.writeFailed || this.queue.length === 0)
      return;
    const drain = this.drainQueue();
    this.drainPromise = drain;
    void drain.finally(() => {
      if (this.drainPromise === drain) this.drainPromise = null;
      if (!this.writeFailed && this.queue.length > 0) this.startDrain();
    });
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0 && !this.writeFailed) {
      const record = this.queue.shift();
      if (record === undefined) continue;
      this.activeRecord = record;
      try {
        await this.appendLine(record.line);
      } catch {
        this.writeFailed = true;
        this.queue.length = 0;
        this.queuedBytes = 0;
        if (!this.writeFailureReported) {
          this.writeFailureReported = true;
          this.report(
            "Unable to write playback diagnostics; recording has stopped.",
          );
        }
      } finally {
        this.queuedBytes = Math.max(0, this.queuedBytes - record.bytes);
        this.activeRecord = null;
      }
    }
  }

  private enqueueLine(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (bytes > this.maxBytes) {
      if (!this.oversizedRecordReported) {
        this.oversizedRecordReported = true;
        this.report("Dropped a record larger than the configured file limit.");
      }
      return;
    }
    const activeCount = this.activeRecord ? 1 : 0;
    if (
      this.queue.length + activeCount >= this.maxQueuedRecords ||
      this.queuedBytes + bytes > this.maxQueuedBytes
    ) {
      if (!this.queueOverflowReported) {
        this.queueOverflowReported = true;
        this.report(
          "Write queue full; new diagnostic records are being dropped.",
        );
      }
      return;
    }
    this.queue.push({ line, bytes });
    this.queuedBytes += bytes;
    this.startDrain();
  }

  private async appendLine(line: string): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    let activeSize = 0;
    try {
      activeSize = (await stat(this.filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (activeSize + Buffer.byteLength(line) > this.maxBytes) {
      await this.rotateFiles();
    }
    const handle = await open(this.filePath, "a", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(line, "utf8");
    } finally {
      await handle.close();
    }
  }

  private async rotateFiles(): Promise<void> {
    if (this.maxArchives > 0) {
      await rm(this.archivePath(this.maxArchives), { force: true });
      for (let index = this.maxArchives - 1; index >= 1; index -= 1) {
        const from = this.archivePath(index);
        const to = this.archivePath(index + 1);
        try {
          await rename(from, to);
          await chmod(to, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      try {
        await rename(this.filePath, this.archivePath(1));
        await chmod(this.archivePath(1), 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      await rm(this.filePath, { force: true });
    }
  }

  private archivePath(index: number): string {
    const extension = extname(this.filePath);
    const base = basename(this.filePath, extension);
    return join(
      dirname(this.filePath),
      base + "." + index + (extension || ".jsonl"),
    );
  }

  private report(message: string): void {
    try {
      console.error("[playback diagnostics] " + message);
    } catch {
      // Logging failures must not escape into playback.
    }
  }
}

export const playbackDiagnostics = new PlaybackDiagnosticsStore();
