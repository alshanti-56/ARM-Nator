const MPEGTS_PACKET_BYTES = 188;
const MPEGTS_SYNC_BYTE = 0x47;
const MPEGTS_TIMESTAMP_WRAP_90K = 2 ** 33;
const MIN_OVERLAP_90K = 0.5 * 90_000;
const MAX_OVERLAP_90K = 60 * 90_000;
const MAX_UNCLASSIFIED_PREFIX_BYTES = 32 * 1024 * 1024;

type ConnectionMode = "passing" | "classifying" | "dropping-overlap";

export interface MpegTsConnectionOverlapStats {
  readonly connection: number;
  readonly firstVideoTimestampSeconds: number | null;
  readonly previousVideoTimestampSeconds: number | null;
  readonly resumedVideoTimestampSeconds: number | null;
  readonly estimatedOverlapSeconds: number;
  readonly droppedBytes: number;
  readonly contentMatchConfirmed: boolean;
}

export interface MpegTsConnectionFinishResult {
  readonly pending: Buffer;
  readonly stats: MpegTsConnectionOverlapStats;
}

/**
 * Filters the short timestamp overlap commonly returned when a live MPEG-TS
 * HTTP endpoint is reopened. FFmpeg would otherwise re-encode those repeated
 * frames onto a new timeline, making the seek clock advance while the viewer
 * watches the same content twice.
 */
export class MpegTsReconnectOverlapFilter {
  private connection = 0;
  private mode: ConnectionMode = "passing";
  private previousVideoTimestamp90k: number | null = null;
  private lastPassedVideoTimestamp90k: number | null = null;
  private firstVideoTimestamp90k: number | null = null;
  private resumedVideoTimestamp90k: number | null = null;
  private estimatedOverlap90k = 0;
  private droppedBytes = 0;
  private contentMatchConfirmed = false;
  private prefix: Buffer[] = [];
  private prefixBytes = 0;
  private readonly recentVideoFingerprints = new Map<number, number>();
  private readonly recentVideoTimestampOrder: number[] = [];

  beginConnection(connection: number): void {
    this.connection = connection;
    this.previousVideoTimestamp90k = this.lastPassedVideoTimestamp90k;
    this.firstVideoTimestamp90k = null;
    this.resumedVideoTimestamp90k = null;
    this.estimatedOverlap90k = 0;
    this.droppedBytes = 0;
    this.contentMatchConfirmed = false;
    this.prefix = [];
    this.prefixBytes = 0;
    this.mode =
      connection > 1 && this.previousVideoTimestamp90k !== null
        ? "classifying"
        : "passing";
  }

  filterPackets(packets: Buffer): Buffer {
    if (packets.length % MPEGTS_PACKET_BYTES !== 0) {
      throw new Error("MPEG-TS overlap filter requires aligned packets.");
    }

    const accepted: Buffer[] = [];
    for (
      let offset = 0;
      offset < packets.length;
      offset += MPEGTS_PACKET_BYTES
    ) {
      const packet = packets.subarray(offset, offset + MPEGTS_PACKET_BYTES);
      const sample = readVideoPesSample(packet);
      const rawTimestamp90k = sample?.timestamp90k ?? null;
      const timestamp90k =
        rawTimestamp90k === null
          ? null
          : unwrapTimestampNear(
              rawTimestamp90k,
              this.mode === "passing"
                ? this.lastPassedVideoTimestamp90k
                : this.previousVideoTimestamp90k,
            );

      if (this.mode === "passing") {
        accepted.push(packet);
        this.observePassedSample(timestamp90k, sample?.fingerprint ?? null);
        continue;
      }

      if (this.mode === "classifying") {
        this.prefix.push(packet);
        this.prefixBytes += packet.length;
        if (timestamp90k !== null && this.firstVideoTimestamp90k === null) {
          this.firstVideoTimestamp90k = timestamp90k;
        }
        if (timestamp90k !== null) {
          const delta90k =
            (this.firstVideoTimestamp90k ?? timestamp90k) -
            (this.previousVideoTimestamp90k ?? timestamp90k);
          const previousFingerprint =
            this.recentVideoFingerprints.get(timestamp90k);
          if (
            delta90k <= -MIN_OVERLAP_90K &&
            delta90k >= -MAX_OVERLAP_90K &&
            sample?.fingerprint !== null &&
            previousFingerprint === sample?.fingerprint
          ) {
            this.mode = "dropping-overlap";
            this.estimatedOverlap90k = -delta90k;
            this.contentMatchConfirmed = true;
            this.droppedBytes += this.prefixBytes;
            this.prefix = [];
            this.prefixBytes = 0;
          } else if (
            delta90k < -MAX_OVERLAP_90K ||
            timestamp90k > (this.previousVideoTimestamp90k ?? timestamp90k) ||
            (previousFingerprint !== undefined &&
              sample?.fingerprint !== null &&
              previousFingerprint !== sample?.fingerprint)
          ) {
            this.mode = "passing";
            if (
              delta90k < -MAX_OVERLAP_90K ||
              previousFingerprint !== undefined
            ) {
              this.clearTimelineHistory();
            }
            accepted.push(this.releasePrefix());
          }
        } else if (this.prefixBytes >= MAX_UNCLASSIFIED_PREFIX_BYTES) {
          this.mode = "passing";
          this.clearTimelineHistory();
          accepted.push(this.releasePrefix());
        }
        continue;
      }

      if (
        timestamp90k !== null &&
        this.previousVideoTimestamp90k !== null &&
        timestamp90k > this.previousVideoTimestamp90k
      ) {
        this.mode = "passing";
        this.resumedVideoTimestamp90k = timestamp90k;
        accepted.push(packet);
        this.observePassedSample(timestamp90k, sample?.fingerprint ?? null);
      } else {
        this.droppedBytes += packet.length;
      }
    }

    return accepted.length === 0 ? Buffer.alloc(0) : Buffer.concat(accepted);
  }

  finishConnection(): MpegTsConnectionFinishResult {
    const pending =
      this.mode === "classifying" && this.prefix.length > 0
        ? this.releasePrefix()
        : Buffer.alloc(0);
    if (pending.length > 0) {
      this.mode = "passing";
    }

    return {
      pending,
      stats: this.connectionStats(),
    };
  }

  connectionStats(): MpegTsConnectionOverlapStats {
    return {
      connection: this.connection,
      firstVideoTimestampSeconds: toSeconds(this.firstVideoTimestamp90k),
      previousVideoTimestampSeconds: toSeconds(this.previousVideoTimestamp90k),
      resumedVideoTimestampSeconds: toSeconds(this.resumedVideoTimestamp90k),
      estimatedOverlapSeconds: this.estimatedOverlap90k / 90_000,
      droppedBytes: this.droppedBytes,
      contentMatchConfirmed: this.contentMatchConfirmed,
    };
  }

  private releasePrefix(): Buffer {
    const prefix = Buffer.concat(this.prefix);
    this.prefix = [];
    this.prefixBytes = 0;
    for (
      let offset = 0;
      offset + MPEGTS_PACKET_BYTES <= prefix.length;
      offset += MPEGTS_PACKET_BYTES
    ) {
      const sample = readVideoPesSample(
        prefix.subarray(offset, offset + MPEGTS_PACKET_BYTES),
      );
      if (!sample) continue;
      const timestamp90k = unwrapTimestampNear(
        sample.timestamp90k,
        this.lastPassedVideoTimestamp90k,
      );
      this.observePassedSample(timestamp90k, sample.fingerprint);
    }
    return prefix;
  }

  private observePassedSample(
    timestamp90k: number | null,
    fingerprint: number | null,
  ): void {
    if (timestamp90k === null) return;
    this.lastPassedVideoTimestamp90k = Math.max(
      this.lastPassedVideoTimestamp90k ?? timestamp90k,
      timestamp90k,
    );
    if (fingerprint === null) return;
    if (!this.recentVideoFingerprints.has(timestamp90k)) {
      this.recentVideoTimestampOrder.push(timestamp90k);
    }
    this.recentVideoFingerprints.set(timestamp90k, fingerprint);
    const oldestRetainedTimestamp90k =
      this.lastPassedVideoTimestamp90k - MAX_OVERLAP_90K;
    while (
      this.recentVideoTimestampOrder.length > 0 &&
      this.recentVideoTimestampOrder[0] < oldestRetainedTimestamp90k
    ) {
      const expiredTimestamp90k = this.recentVideoTimestampOrder.shift();
      if (expiredTimestamp90k !== undefined) {
        this.recentVideoFingerprints.delete(expiredTimestamp90k);
      }
    }
  }

  private clearTimelineHistory(): void {
    this.lastPassedVideoTimestamp90k = null;
    this.recentVideoFingerprints.clear();
    this.recentVideoTimestampOrder.length = 0;
  }
}

export function readVideoPesTimelineTimestamp90k(
  packet: Uint8Array,
): number | null {
  return readVideoPesSample(packet)?.timestamp90k ?? null;
}

function readVideoPesSample(
  packet: Uint8Array,
): { timestamp90k: number; fingerprint: number | null } | null {
  if (
    packet.length !== MPEGTS_PACKET_BYTES ||
    packet[0] !== MPEGTS_SYNC_BYTE ||
    (packet[1] & 0x40) === 0
  ) {
    return null;
  }

  const adaptationFieldControl = (packet[3] >> 4) & 0x03;
  if (adaptationFieldControl !== 1 && adaptationFieldControl !== 3) {
    return null;
  }
  const payloadOffset = adaptationFieldControl === 3 ? 5 + packet[4] : 4;
  if (
    payloadOffset + 14 > packet.length ||
    packet[payloadOffset] !== 0 ||
    packet[payloadOffset + 1] !== 0 ||
    packet[payloadOffset + 2] !== 1
  ) {
    return null;
  }

  const streamId = packet[payloadOffset + 3];
  if (streamId < 0xe0 || streamId > 0xef) {
    return null;
  }
  const ptsDtsFlags = packet[payloadOffset + 7] & 0xc0;
  if (ptsDtsFlags !== 0x80 && ptsDtsFlags !== 0xc0) {
    return null;
  }
  const timestampOffset = payloadOffset + (ptsDtsFlags === 0xc0 ? 14 : 9);
  if (timestampOffset + 5 > packet.length) {
    return null;
  }
  const timestamp90k = readPesTimestamp90k(packet, timestampOffset);
  const elementaryStreamOffset = payloadOffset + 9 + packet[payloadOffset + 8];
  return {
    timestamp90k,
    fingerprint:
      elementaryStreamOffset < packet.length
        ? fingerprintBytes(packet, elementaryStreamOffset)
        : null,
  };
}

function fingerprintBytes(bytes: Uint8Array, offset: number): number {
  let hash = 0x811c9dc5;
  for (let index = offset; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function readPesTimestamp90k(packet: Uint8Array, offset: number): number {
  return (
    (packet[offset] & 0x0e) * 2 ** 29 +
    packet[offset + 1] * 2 ** 22 +
    (packet[offset + 2] & 0xfe) * 2 ** 14 +
    packet[offset + 3] * 2 ** 7 +
    (packet[offset + 4] & 0xfe) / 2
  );
}

function unwrapTimestampNear(
  raw90k: number,
  reference90k: number | null,
): number {
  if (reference90k === null) {
    return raw90k;
  }
  return (
    raw90k +
    Math.round((reference90k - raw90k) / MPEGTS_TIMESTAMP_WRAP_90K) *
      MPEGTS_TIMESTAMP_WRAP_90K
  );
}

function toSeconds(timestamp90k: number | null): number | null {
  return timestamp90k === null ? null : timestamp90k / 90_000;
}
