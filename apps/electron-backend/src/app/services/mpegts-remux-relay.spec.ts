import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  MpegTsReconnectOverlapFilter,
  readVideoPesTimelineTimestamp90k,
} from "./mpegts-reconnect-overlap";
import {
  findPacketSyncOffset,
  pipeAlignedMpegTsPackets,
  readMpegTsPcrSeconds,
  relayMpegTsWithFfmpeg,
} from "./mpegts-remux-relay";

const PACKET_BYTES = 188;
const execFileAsync = promisify(execFile);
const BUNDLED_FFMPEG = path.resolve(
  "apps/electron-backend/native/build/Release/ffmpeg",
);

function packet(fill: number): Buffer {
  const result = Buffer.alloc(PACKET_BYTES, fill);
  result[0] = 0x47;
  return result;
}

function packetWithPcr(seconds: number): Buffer {
  const result = packet(0xff);
  const pcrBase = Math.round(seconds * 90_000);
  result[3] = 0x20;
  result[4] = 7;
  result[5] = 0x10;
  result[6] = Math.floor(pcrBase / 2 ** 25) & 0xff;
  result[7] = Math.floor(pcrBase / 2 ** 17) & 0xff;
  result[8] = Math.floor(pcrBase / 2 ** 9) & 0xff;
  result[9] = Math.floor(pcrBase / 2) & 0xff;
  result[10] = ((pcrBase & 0x01) << 7) | 0x7e;
  result[11] = 0;
  return result;
}

function packetWithVideoPts(seconds: number, contentMarker = 0xff): Buffer {
  const result = packet(0xff);
  const pts = Math.round(seconds * 90_000);
  result[1] = 0x41;
  result[2] = 0x00;
  result[3] = 0x10;
  result[4] = 0;
  result[5] = 0;
  result[6] = 1;
  result[7] = 0xe0;
  result[8] = 0;
  result[9] = 0;
  result[10] = 0x80;
  result[11] = 0x80;
  result[12] = 5;
  result[13] = 0x21 | (Math.floor(pts / 2 ** 29) & 0x0e);
  result[14] = Math.floor(pts / 2 ** 22) & 0xff;
  result[15] = (Math.floor(pts / 2 ** 14) & 0xfe) | 1;
  result[16] = Math.floor(pts / 2 ** 7) & 0xff;
  result[17] = ((pts % 2 ** 7) << 1) | 1;
  result.fill(contentMarker, 18);
  return result;
}

function response(...chunks: Buffer[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "video/mp2t" } },
  );
}

test("finds a packet boundary after leading transport noise", () => {
  const input = Buffer.concat([
    Buffer.from([1, 2, 3, 4]),
    packet(0x11),
    packet(0x22),
    packet(0x33),
  ]);
  assert.equal(findPacketSyncOffset(input), 4);
});

test("reads the transport clock used to pace remuxed output", () => {
  assert.equal(readMpegTsPcrSeconds(packetWithPcr(1.5)), 1.5);
  assert.equal(readMpegTsPcrSeconds(packet(0x11)), null);
});

test("reads a video PES timestamp used to identify reconnect overlap", () => {
  assert.equal(
    readVideoPesTimelineTimestamp90k(packetWithVideoPts(12.5)),
    12.5 * 90_000,
  );
  assert.equal(readVideoPesTimelineTimestamp90k(packet(0x11)), null);
});

test("drops the repeated timestamp interval from a reopened live stream", () => {
  const filter = new MpegTsReconnectOverlapFilter();
  const firstConnection = Buffer.concat(
    Array.from({ length: 11 }, (_, second) => packetWithVideoPts(second)),
  );
  filter.beginConnection(1);
  assert.deepEqual(filter.filterPackets(firstConnection), firstConnection);
  filter.finishConnection();

  const reopenedConnection = Buffer.concat(
    Array.from({ length: 11 }, (_, index) => packetWithVideoPts(index + 5)),
  );
  filter.beginConnection(2);
  const filtered = filter.filterPackets(reopenedConnection);
  const { stats } = filter.finishConnection();

  assert.deepEqual(
    filtered,
    Buffer.concat(
      Array.from({ length: 5 }, (_, index) => packetWithVideoPts(index + 11)),
    ),
  );
  assert.equal(stats.estimatedOverlapSeconds, 5);
  assert.equal(stats.droppedBytes, PACKET_BYTES * 6);
  assert.equal(stats.resumedVideoTimestampSeconds, 11);
  assert.equal(stats.contentMatchConfirmed, true);
});

test("preserves new content after a small source timestamp reset", () => {
  const filter = new MpegTsReconnectOverlapFilter();
  filter.beginConnection(1);
  filter.filterPackets(
    Buffer.concat(
      Array.from({ length: 11 }, (_, second) =>
        packetWithVideoPts(second, second),
      ),
    ),
  );
  filter.finishConnection();

  const resetWithNewContent = Buffer.concat(
    Array.from({ length: 11 }, (_, index) =>
      packetWithVideoPts(index + 5, index + 100),
    ),
  );
  filter.beginConnection(2);
  assert.deepEqual(
    filter.filterPackets(resetWithNewContent),
    resetWithNewContent,
  );
  const { stats } = filter.finishConnection();
  assert.equal(stats.droppedBytes, 0);
  assert.equal(stats.contentMatchConfirmed, false);
});

test("does not treat a large source timestamp reset as replay overlap", () => {
  const filter = new MpegTsReconnectOverlapFilter();
  filter.beginConnection(1);
  filter.filterPackets(
    Buffer.concat([packetWithVideoPts(100), packetWithVideoPts(101)]),
  );
  filter.finishConnection();

  const resetConnection = Buffer.concat([
    packetWithVideoPts(1),
    packetWithVideoPts(2),
  ]);
  filter.beginConnection(2);
  assert.deepEqual(filter.filterPackets(resetConnection), resetConnection);
  assert.equal(filter.finishConnection().stats.droppedBytes, 0);
});

test(
  "removes a reconnect overlap from real FFmpeg-generated MPEG-TS",
  { skip: !existsSync(BUNDLED_FFMPEG) },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "arm-nator-ts-"));
    const fixture = path.join(directory, "timeline.ts");
    try {
      await execFileAsync(BUNDLED_FFMPEG, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=160x90:rate=10",
        "-t",
        "12",
        "-an",
        "-c:v",
        "mpeg2video",
        "-bf",
        "0",
        "-g",
        "10",
        "-muxdelay",
        "0",
        "-f",
        "mpegts",
        fixture,
      ]);

      const transportStream = await readFile(fixture);
      const timestampPackets: Array<{ offset: number; timestamp90k: number }> =
        [];
      for (
        let offset = 0;
        offset + PACKET_BYTES <= transportStream.length;
        offset += PACKET_BYTES
      ) {
        const timestamp90k = readVideoPesTimelineTimestamp90k(
          transportStream.subarray(offset, offset + PACKET_BYTES),
        );
        if (timestamp90k !== null) {
          timestampPackets.push({ offset, timestamp90k });
        }
      }
      assert.ok(timestampPackets.length >= 100);
      const firstTimestamp90k = timestampPackets[0].timestamp90k;
      const atOrAfter = (seconds: number) => {
        const packet = timestampPackets.find(
          ({ timestamp90k }) =>
            timestamp90k >= firstTimestamp90k + seconds * 90_000,
        );
        assert.ok(packet, `missing MPEG-TS timestamp at ${seconds}s`);
        return packet.offset;
      };

      const firstConnection = transportStream.subarray(0, atOrAfter(8));
      const reopenedConnection = transportStream.subarray(atOrAfter(4));
      const filter = new MpegTsReconnectOverlapFilter();
      filter.beginConnection(1);
      const acceptedFirst = filter.filterPackets(firstConnection);
      filter.finishConnection();
      filter.beginConnection(2);
      const acceptedReopen = filter.filterPackets(reopenedConnection);
      const { stats } = filter.finishConnection();

      const acceptedPackets = Buffer.concat([acceptedFirst, acceptedReopen]);
      const acceptedTimestamps: number[] = [];
      for (
        let offset = 0;
        offset + PACKET_BYTES <= acceptedPackets.length;
        offset += PACKET_BYTES
      ) {
        const timestamp90k = readVideoPesTimelineTimestamp90k(
          acceptedPackets.subarray(offset, offset + PACKET_BYTES),
        );
        if (timestamp90k !== null) acceptedTimestamps.push(timestamp90k);
      }
      for (let index = 1; index < acceptedTimestamps.length; index += 1) {
        assert.ok(
          acceptedTimestamps[index] > acceptedTimestamps[index - 1],
          `timestamp repeated at packet ${index}`,
        );
      }
      assert.ok(stats.estimatedOverlapSeconds >= 3.8);
      assert.ok(stats.droppedBytes > 0);
      assert.ok(stats.resumedVideoTimestampSeconds !== null);
      assert.equal(stats.contentMatchConfirmed, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("drops incomplete bytes at an upstream MPEG-TS boundary", async () => {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const body = response(
    Buffer.concat([
      Buffer.from([9, 8, 7]),
      packet(0x11),
      packet(0x22),
      Buffer.alloc(41, 0xaa),
    ]),
  ).body;
  assert.ok(body);

  const written = await pipeAlignedMpegTsPackets(
    body,
    output,
    new AbortController().signal,
    () => undefined,
  );
  assert.equal(written, PACKET_BYTES * 2);
  assert.deepEqual(
    Buffer.concat(chunks),
    Buffer.concat([packet(0x11), packet(0x22)]),
  );
});

test("keeps one remux process alive across upstream reconnects", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "arm-nator-remux-"));
  const executable = path.join(directory, "ffmpeg-fixture");
  await writeFile(
    executable,
    // This fixture only echoes bytes. A cold Node runtime can exceed the real
    // remuxer's one-second exit grace when the suite is under CPU pressure.
    "#!/bin/sh\nexec /bin/cat\n",
    "utf8",
  );
  await chmod(executable, 0o755);

  const output = new PassThrough();
  const outputChunks: Buffer[] = [];
  let capturedOutputBytes = 0;
  output.on("data", (chunk: Buffer) => {
    const copy = Buffer.from(chunk);
    outputChunks.push(copy);
    capturedOutputBytes += copy.length;
  });
  const waitForOutputBytes = (minimumBytes: number): Promise<void> => {
    if (capturedOutputBytes >= minimumBytes) return Promise.resolve();
    return new Promise((resolve) => {
      const onData = () => {
        if (capturedOutputBytes < minimumBytes) return;
        clearTimeout(timer);
        output.off("data", onData);
        resolve();
      };
      const timer = setTimeout(() => {
        output.off("data", onData);
        resolve();
      }, 5_000);
      output.on("data", onData);
    });
  };
  let reopenCount = 0;
  let started = false;
  try {
    const result = await relayMpegTsWithFfmpeg({
      ffmpegPath: executable,
      firstUpstream: response(
        packet(0x11),
        packet(0x12),
        Buffer.alloc(17, 0xaa),
      ),
      reopenUpstream: async () => {
        reopenCount += 1;
        if (reopenCount === 1) {
          return response(
            packet(0x21),
            packet(0x22),
            Buffer.alloc(23, 0xbb),
          );
        }
        await waitForOutputBytes(PACKET_BYTES * 4);
        return new Response(null, { status: 403 });
      },
      output,
      signal: new AbortController().signal,
      onActivity: () => undefined,
      onStarted: () => {
        started = true;
      },
    });

    assert.equal(started, true);
    assert.equal(result.upstreamConnections, 3);
    assert.equal(reopenCount, 2);
    assert.deepEqual(
      Buffer.concat(outputChunks),
      Buffer.concat([packet(0x11), packet(0x12), packet(0x21), packet(0x22)]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
