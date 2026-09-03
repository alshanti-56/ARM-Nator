import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { PassThrough, type Readable, type Writable } from "node:stream";
import {
  MpegTsReconnectOverlapFilter,
  type MpegTsConnectionOverlapStats,
} from "./mpegts-reconnect-overlap";

const MPEGTS_PACKET_BYTES = 188;
const MPEGTS_SYNC_BYTE = 0x47;
const HEALTHY_UPSTREAM_BYTES = MPEGTS_PACKET_BYTES * 100;
const RECONNECT_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000] as const;
const CHILD_EXIT_GRACE_MS = 1_000;
const MAX_STDERR_BYTES = 16 * 1024;
const UPSTREAM_IDLE_MS = 3_000;
const PACED_OUTPUT_BUFFER_BYTES = 64 * 1024 * 1024;
const PACED_OUTPUT_INITIAL_BURST_SECONDS = 8;
const PACED_OUTPUT_BLOCK_BYTES = MPEGTS_PACKET_BYTES * 256;
const MPEGTS_PCR_WRAP_SECONDS = 2 ** 33 / 90_000;

export const MPEGTS_REMUX_ARGUMENTS = [
  "-hide_banner",
  "-loglevel",
  "warning",
  "-nostdin",
  "-fflags",
  "+genpts+discardcorrupt",
  "-probesize",
  "1M",
  "-analyzeduration",
  "2M",
  "-f",
  "mpegts",
  "-i",
  "pipe:0",
  "-map",
  "0:v:0?",
  "-map",
  "0:a:0?",
  "-c:v",
  "h264_videotoolbox",
  "-realtime",
  "1",
  "-allow_sw",
  "1",
  "-b:v",
  "8M",
  "-maxrate",
  "10M",
  "-bufsize",
  "16M",
  "-g",
  "100",
  "-force_key_frames",
  "expr:gte(t,n_forced*2)",
  "-vf",
  "bwdif=mode=send_frame:parity=auto:deint=interlaced",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-ac",
  "2",
  "-ar",
  "48000",
  "-af",
  "aresample=async=1:first_pts=0",
  "-dts_delta_threshold",
  "1",
  "-avoid_negative_ts",
  "make_non_negative",
  "-muxdelay",
  "0",
  "-muxpreload",
  "0",
  "-mpegts_flags",
  "+resend_headers+initial_discontinuity",
  "-flush_packets",
  "1",
  "-f",
  "mpegts",
  "pipe:1",
] as const;

export interface MpegTsRemuxRelayOptions {
  readonly ffmpegPath: string;
  readonly firstUpstream: Response;
  readonly reopenUpstream: (signal: AbortSignal) => Promise<Response>;
  readonly output: Writable;
  readonly signal: AbortSignal;
  readonly onActivity: () => void;
  readonly onStarted?: () => void;
  readonly onUpstreamConnected?: (connection: number) => void;
}

export interface MpegTsRemuxRelayResult {
  readonly stderr: string;
  readonly upstreamConnections: number;
  readonly outputBytes: number;
  readonly rendererBytes: number;
  readonly rendererDisconnected: boolean;
}

export class MpegTsRemuxStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MpegTsRemuxStartupError";
  }
}

export async function relayMpegTsWithFfmpeg(
  options: MpegTsRemuxRelayOptions,
): Promise<MpegTsRemuxRelayResult> {
  const child = spawn(options.ffmpegPath, [...MPEGTS_REMUX_ARGUMENTS], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForChildStartup(child);

  const relayAbort = new AbortController();
  const combinedSignal = AbortSignal.any([options.signal, relayAbort.signal]);
  let stderr = "";
  let childClosed = false;
  let upstreamConnections = 0;
  let outputBytes = 0;
  let rendererBytes = 0;

  child.stderr.on("data", (chunk: Buffer | string) => {
    if (stderr.length < MAX_STDERR_BYTES) {
      stderr += Buffer.from(chunk)
        .toString("utf8")
        .slice(0, MAX_STDERR_BYTES - stderr.length);
    }
  });
  child.stdin.on("error", () => relayAbort.abort());
  child.stdout.on("error", () => relayAbort.abort());
  child.stdout.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.from(chunk);
    outputBytes += buffer.length;
  });
  options.onStarted?.();
  const pacedOutputBuffer = new PassThrough({
    readableHighWaterMark: PACED_OUTPUT_BUFFER_BYTES,
    writableHighWaterMark: PACED_OUTPUT_BUFFER_BYTES,
  });
  child.stdout.pipe(pacedOutputBuffer);
  const outputRelay = pipePacedMpegTsOutput(
    pacedOutputBuffer,
    options.output,
    options.signal,
  )
    .then((bytes) => {
      rendererBytes = bytes;
    })
    .catch(() => relayAbort.abort());

  const childClose = once(child, "close").then(() => {
    childClosed = true;
    relayAbort.abort();
  });

  try {
    const overlapFilter = new MpegTsReconnectOverlapFilter();
    upstreamConnections = await feedUpstreams(
      child,
      options.firstUpstream,
      options.reopenUpstream,
      combinedSignal,
      options.onActivity,
      options.onUpstreamConnected,
      overlapFilter,
    );
  } finally {
    relayAbort.abort();
    if (!child.stdin.destroyed) {
      child.stdin.end();
    }
    if (!childClosed) {
      await Promise.race([childClose, delay(CHILD_EXIT_GRACE_MS)]);
    }
    if (!childClosed) {
      child.kill("SIGTERM");
      await Promise.race([childClose, delay(CHILD_EXIT_GRACE_MS)]);
    }
    if (!childClosed) {
      child.kill("SIGKILL");
    }
    if (!options.signal.aborted && childClosed) {
      await outputRelay;
    } else {
      await Promise.race([outputRelay, delay(CHILD_EXIT_GRACE_MS)]);
    }
    child.stdout.unpipe(pacedOutputBuffer);
    pacedOutputBuffer.destroy();
  }

  return {
    stderr: stderr.trim(),
    upstreamConnections,
    outputBytes,
    rendererBytes,
    rendererDisconnected: options.signal.aborted,
  };
}

async function pipePacedMpegTsOutput(
  source: Readable,
  output: Writable,
  signal: AbortSignal,
): Promise<number> {
  let pending = Buffer.alloc(0);
  let firstPcrSeconds: number | null = null;
  let previousRawPcrSeconds: number | null = null;
  let pcrWrapOffsetSeconds = 0;
  let startedAt = 0;
  let writtenBytes = 0;

  for await (const rawChunk of source) {
    if (signal.aborted) break;
    pending = Buffer.concat([pending, Buffer.from(rawChunk)]);
    while (pending.length >= MPEGTS_PACKET_BYTES) {
      const completeBytes =
        Math.floor(pending.length / MPEGTS_PACKET_BYTES) * MPEGTS_PACKET_BYTES;
      const blockBytes = Math.min(completeBytes, PACED_OUTPUT_BLOCK_BYTES);
      const packets = pending.subarray(0, blockBytes);
      pending = pending.subarray(blockBytes);
      let lastPcrSeconds: number | null = null;
      for (
        let offset = 0;
        offset + MPEGTS_PACKET_BYTES <= packets.length;
        offset += MPEGTS_PACKET_BYTES
      ) {
        const rawPcrSeconds = readMpegTsPcrSeconds(packets, offset);
        if (rawPcrSeconds === null) continue;
        if (
          previousRawPcrSeconds !== null &&
          rawPcrSeconds < previousRawPcrSeconds - MPEGTS_PCR_WRAP_SECONDS / 2
        ) {
          pcrWrapOffsetSeconds += MPEGTS_PCR_WRAP_SECONDS;
        }
        previousRawPcrSeconds = rawPcrSeconds;
        lastPcrSeconds = rawPcrSeconds + pcrWrapOffsetSeconds;
        if (firstPcrSeconds === null) {
          firstPcrSeconds = lastPcrSeconds;
          startedAt = Date.now();
        }
      }

      if (firstPcrSeconds !== null && lastPcrSeconds !== null) {
        const dueAfterMs = Math.max(
          0,
          (lastPcrSeconds -
            firstPcrSeconds -
            PACED_OUTPUT_INITIAL_BURST_SECONDS) *
            1_000,
        );
        const waitMs = startedAt + dueAfterMs - Date.now();
        if (waitMs > 0 && !(await abortableDelay(waitMs, signal))) {
          return writtenBytes;
        }
      }

      await writeWithBackpressure(output, packets, signal);
      writtenBytes += packets.length;
    }
  }
  return writtenBytes;
}

export function readMpegTsPcrSeconds(
  packets: Uint8Array,
  offset = 0,
): number | null {
  if (
    offset < 0 ||
    offset + MPEGTS_PACKET_BYTES > packets.length ||
    packets[offset] !== MPEGTS_SYNC_BYTE
  ) {
    return null;
  }
  const adaptationFieldControl = (packets[offset + 3] >> 4) & 0x03;
  if (adaptationFieldControl !== 2 && adaptationFieldControl !== 3) {
    return null;
  }
  const adaptationLength = packets[offset + 4];
  if (
    adaptationLength < 7 ||
    offset + 5 + adaptationLength > offset + MPEGTS_PACKET_BYTES ||
    (packets[offset + 5] & 0x10) === 0
  ) {
    return null;
  }
  const pcrBase =
    packets[offset + 6] * 2 ** 25 +
    packets[offset + 7] * 2 ** 17 +
    packets[offset + 8] * 2 ** 9 +
    packets[offset + 9] * 2 +
    (packets[offset + 10] >> 7);
  const pcrExtension =
    ((packets[offset + 10] & 0x01) << 8) | packets[offset + 11];
  return (pcrBase * 300 + pcrExtension) / 27_000_000;
}

async function waitForChildStartup(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  await Promise.race([
    once(child, "spawn").then(() => undefined),
    once(child, "error").then(([error]) => {
      throw new MpegTsRemuxStartupError(
        `Unable to start the MPEG-TS remuxer: ${String(error)}`,
      );
    }),
  ]);
}

async function feedUpstreams(
  child: ChildProcessWithoutNullStreams,
  firstUpstream: Response,
  reopenUpstream: (signal: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
  onActivity: () => void,
  onUpstreamConnected?: (connection: number) => void,
  overlapFilter?: MpegTsReconnectOverlapFilter,
): Promise<number> {
  let upstream: Response | null = firstUpstream;
  let connections = 0;
  let consecutiveFailures = 0;

  while (!signal.aborted && !child.stdin.destroyed) {
    if (!upstream) {
      try {
        upstream = await reopenUpstream(signal);
      } catch {
        if (signal.aborted) {
          break;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures > RECONNECT_DELAYS_MS.length) {
          break;
        }
        if (
          !(await abortableDelay(
            RECONNECT_DELAYS_MS[
              Math.min(consecutiveFailures - 1, RECONNECT_DELAYS_MS.length - 1)
            ],
            signal,
          ))
        ) {
          break;
        }
        continue;
      }
    }

    connections += 1;
    onUpstreamConnected?.(connections);
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
      if (!isRecoverableStatus(upstream.status)) {
        break;
      }
      consecutiveFailures += 1;
    } else {
      const startedAt = Date.now();
      let bytes = 0;
      try {
        overlapFilter?.beginConnection(connections);
        bytes = await pipeAlignedMpegTsPackets(
          upstream.body,
          child.stdin,
          signal,
          onActivity,
          overlapFilter,
        );
        if (overlapFilter) {
          logConnectionOverlap(overlapFilter.connectionStats());
        }
      } catch {
        if (signal.aborted || child.stdin.destroyed) {
          break;
        }
      }
      const healthy =
        bytes >= HEALTHY_UPSTREAM_BYTES ||
        (bytes > 0 && Date.now() - startedAt >= 1_000);
      consecutiveFailures = healthy ? 0 : consecutiveFailures + 1;
    }
    upstream = null;

    if (
      signal.aborted ||
      child.stdin.destroyed ||
      consecutiveFailures > RECONNECT_DELAYS_MS.length
    ) {
      break;
    }

    const delayMs =
      consecutiveFailures === 0
        ? RECONNECT_DELAYS_MS[0]
        : RECONNECT_DELAYS_MS[
            Math.min(consecutiveFailures - 1, RECONNECT_DELAYS_MS.length - 1)
          ];
    if (!(await abortableDelay(delayMs, signal))) {
      break;
    }
  }

  return connections;
}

export async function pipeAlignedMpegTsPackets(
  body: ReadableStream<Uint8Array>,
  output: Writable,
  signal: AbortSignal,
  onActivity: () => void,
  overlapFilter?: MpegTsReconnectOverlapFilter,
): Promise<number> {
  const reader = body.getReader();
  let pending = Buffer.alloc(0);
  let synchronized = false;
  let writtenBytes = 0;
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });

  try {
    while (!signal.aborted) {
      const { done, value } = await readWithIdleTimeout(reader, signal);
      if (done) {
        break;
      }
      pending = Buffer.concat([pending, Buffer.from(value)]);
      if (!synchronized) {
        const syncOffset = findPacketSyncOffset(pending);
        if (syncOffset < 0) {
          pending = pending.subarray(
            Math.max(0, pending.length - MPEGTS_PACKET_BYTES * 3),
          );
          continue;
        }
        pending = pending.subarray(syncOffset);
        synchronized = true;
      }

      const completeBytes =
        Math.floor(pending.length / MPEGTS_PACKET_BYTES) * MPEGTS_PACKET_BYTES;
      if (completeBytes === 0) {
        continue;
      }
      const packets = pending.subarray(0, completeBytes);
      pending = pending.subarray(completeBytes);
      const filteredPackets = overlapFilter
        ? overlapFilter.filterPackets(packets)
        : packets;
      if (filteredPackets.length > 0) {
        await writeWithBackpressure(output, filteredPackets, signal);
        writtenBytes += filteredPackets.length;
        onActivity();
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }

  if (!signal.aborted && overlapFilter) {
    const { pending: filteredPending } = overlapFilter.finishConnection();
    if (filteredPending.length > 0) {
      await writeWithBackpressure(output, filteredPending, signal);
      writtenBytes += filteredPending.length;
      onActivity();
    }
  }

  return writtenBytes;
}

function logConnectionOverlap(stats: MpegTsConnectionOverlapStats): void {
  if (stats.connection <= 1 || stats.droppedBytes === 0) {
    return;
  }
  console.info(
    `[MPEG-TS relay] Removed ${stats.estimatedOverlapSeconds.toFixed(3)}s content-verified overlap (${stats.droppedBytes} byte(s)) from upstream connection ${stats.connection}.`,
  );
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.resolve({ done: true, value: undefined });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (result: ReadableStreamReadResult<Uint8Array>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      finish({ done: true, value: undefined });
    };
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      finish({ done: true, value: undefined });
    }, UPSTREAM_IDLE_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(finish, fail);
  });
}

export function findPacketSyncOffset(buffer: Uint8Array): number {
  const maximumOffset = Math.min(MPEGTS_PACKET_BYTES, buffer.length);
  for (let offset = 0; offset < maximumOffset; offset += 1) {
    if (buffer[offset] !== MPEGTS_SYNC_BYTE) {
      continue;
    }
    const second = offset + MPEGTS_PACKET_BYTES;
    if (second < buffer.length && buffer[second] === MPEGTS_SYNC_BYTE) {
      return offset;
    }
  }
  return -1;
}

async function writeWithBackpressure(
  output: Writable,
  chunk: Buffer,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || output.destroyed) {
    throw new Error("MPEG-TS remux input closed.");
  }
  if (output.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      output.off("drain", onDrain);
      output.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    output.once("drain", onDrain);
    output.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecoverableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
