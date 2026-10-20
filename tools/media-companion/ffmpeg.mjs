import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

const CAPABILITY_COMMAND_TIMEOUT_MS = 2_000;
const ENCODER_PROOF_TIMEOUT_MS = 2_000;

export function runCapture(command, args, { timeoutMs = 8_000, maxOutputBytes = 2_000_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('process_timeout'));
    }, timeoutMs);
    timer.unref?.();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new Error('process_output_limit'));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(Object.assign(new Error('process_failed'), { code: code ?? -1, stderr }));
    });
  });
}

async function proofEncode(ffmpegPath, args, timeoutMs = ENCODER_PROOF_TIMEOUT_MS) {
  try {
    await runCapture(ffmpegPath, args, { timeoutMs, maxOutputBytes: 256_000 });
    return true;
  } catch {
    return false;
  }
}

export async function inspectFfmpeg({ ffmpegPath, ffprobePath, enableConversion }) {
  const result = {
    ffmpeg: false,
    ffprobe: false,
    remux: false,
    convert: {
      enabled: enableConversion,
      available: false,
      hdrTonemap: false,
      reason: null,
      videoEncoder: null,
      encoderMode: null,
      softwareThreads: 2,
      softwareRealtime: false,
    },
  };
  const [ffmpegVersion, ffprobeVersion] = await Promise.allSettled([
    runCapture(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: CAPABILITY_COMMAND_TIMEOUT_MS }),
    runCapture(ffprobePath, ['-hide_banner', '-version'], { timeoutMs: CAPABILITY_COMMAND_TIMEOUT_MS }),
  ]);
  if (ffmpegVersion.status === 'fulfilled') {
    result.version = ffmpegVersion.value.stdout.split('\n')[0] || 'available';
    result.ffmpeg = true;
    result.remux = true;
  } else {
    result.convert.reason = 'ffmpeg_unavailable';
  }
  if (ffprobeVersion.status === 'fulfilled') result.ffprobe = true;
  else if (enableConversion) result.convert.reason = 'ffprobe_unavailable';

  if (!enableConversion) {
    result.convert.reason = 'disabled';
    return result;
  }
  if (!result.ffmpeg) return result;

  const [encoderScan, filterScan] = await Promise.allSettled([
    runCapture(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: CAPABILITY_COMMAND_TIMEOUT_MS }),
    runCapture(ffmpegPath, ['-hide_banner', '-filters'], { timeoutMs: CAPABILITY_COMMAND_TIMEOUT_MS }),
  ]);
  if (encoderScan.status !== 'fulfilled' || filterScan.status !== 'fulfilled') {
    result.convert.reason = 'capability_scan_failed';
    return result;
  }
  const encoders = encoderScan.value.stdout;
  const filters = filterScan.value.stdout;
  const hasEncoder = (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(encoders);
  const hasFilter = (name) => new RegExp(`\\b${name}\\b`).test(filters);
  if (!hasEncoder('aac') || !hasFilter('scale')) {
    result.convert.reason = 'required_encoder_or_filter_unavailable';
    return result;
  }

  const audioProof = await proofEncode(ffmpegPath, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.1',
    '-vn', '-c:a', 'aac', '-f', 'null', '-',
  ]);
  if (!audioProof) {
    result.convert.reason = 'aac_encoder_proof_failed';
    return result;
  }

  const hardwareEncoders = ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf'];
  for (const encoder of hardwareEncoders) {
    if (!hasEncoder(encoder)) continue;
    const proven = await proofEncode(ffmpegPath, [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
      '-frames:v', '1', '-an', '-vf', 'scale=64:64', '-c:v', encoder, '-pix_fmt', 'yuv420p', '-f', 'null', '-',
    ]);
    if (proven) {
      result.convert.videoEncoder = encoder;
      result.convert.encoderMode = 'hardware';
      break;
    }
  }
  if (!result.convert.videoEncoder && hasEncoder('libx264')) {
    result.convert.videoEncoder = 'libx264';
    result.convert.encoderMode = 'software';
    const softwareProof = await proofEncode(ffmpegPath, [
        '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
        '-frames:v', '90', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast',
        '-crf', '23', '-pix_fmt', 'yuv420p', '-f', 'null', '-',
      ], 3_500);
    if (softwareProof) {
      result.convert.softwareRealtime = true;
    } else {
      result.convert.reason = 'software_too_slow';
      return result;
    }
  }
  if (!result.convert.videoEncoder) {
    result.convert.reason = 'no_proven_h264_encoder';
    return result;
  }
  if (!result.ffprobe) {
    result.convert.reason = 'ffprobe_unavailable';
    return result;
  }
  result.convert.available = true;
  result.convert.reason = null;

  if (hasFilter('zscale') && hasFilter('tonemap')) {
    const hdrProofArgs = [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=16x16:d=0.1',
      '-frames:v', '1', '-vf',
      'zscale=transfer=linear:npl=100,tonemap=tonemap=mobius:desat=0,zscale=transfer=bt709:matrix=bt709:primaries=bt709',
      '-an',
    ];
    addVideoEncoder(hdrProofArgs, result.convert.videoEncoder);
    hdrProofArgs.push('-pix_fmt', 'yuv420p', '-f', 'null', '-');
    result.convert.hdrTonemap = await proofEncode(ffmpegPath, hdrProofArgs);
  }
  return result;
}

export async function probeMedia(ffprobePath, inputUrl, signal) {
  const { stdout } = await runCapture(ffprobePath, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', inputUrl,
  ], { timeoutMs: 20_000, maxOutputBytes: 2_000_000, signal });
  const result = JSON.parse(stdout);
  const streams = Array.isArray(result.streams) ? result.streams : [];
  const formatDuration = Number(result.format?.duration);
  const streamDurations = streams.map((stream) => Number(stream.duration)).filter((duration) => Number.isFinite(duration) && duration > 0);
  streams.durationSeconds = Number.isFinite(formatDuration) && formatDuration > 0
    ? formatDuration
    : streamDurations.reduce((maximum, duration) => Math.max(maximum, duration), 0) || null;
  return streams;
}

function addVideoEncoder(args, encoder) {
  if (encoder === 'h264_videotoolbox') args.push('-c:v', encoder, '-b:v', '5M');
  else if (encoder === 'h264_nvenc') args.push('-c:v', encoder, '-preset', 'p4', '-cq', '23', '-b:v', '0');
  else if (encoder === 'h264_qsv') args.push('-c:v', encoder, '-preset', 'medium', '-global_quality', '23');
  else if (encoder === 'h264_amf') args.push('-c:v', encoder, '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23');
  else args.push('-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '23');
}

function hlsArgs({ outputDir, inputUrl, isLive, startTime, audioOnly, streams, videoEncoder = 'libx264' }) {
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
  if (startTime > 0) args.push('-ss', String(startTime));
  args.push('-i', inputUrl);

  if (streams) {
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    if (!video && !audio) throw Object.assign(new Error('no_supported_tracks'), { publicCode: 'no_supported_tracks' });
    if (audioOnly && !audio) throw Object.assign(new Error('audio_track_required'), { publicCode: 'audio_track_required' });

    const transfer = String(video?.color_transfer ?? '').toLowerCase();
    const hdr = transfer === 'smpte2084' || transfer === 'arib-std-b67';
    if (hdr && !streams.hdrTonemapAvailable) {
      throw Object.assign(new Error('hdr_tonemap_unavailable'), { publicCode: 'hdr_tonemap_unavailable' });
    }
    const copyCompatibleVideo = audioOnly && video && video.codec_name === 'h264'
      && video.pix_fmt === 'yuv420p' && !hdr
      && Number(video.width) <= 1920 && Number(video.height) <= 1080;
    if (video) args.push('-map', '0:v:0');
    if (audio) args.push('-map', '0:a:0');
    if (video && copyCompatibleVideo) {
      args.push('-c:v', 'copy');
    } else if (video) {
      addVideoEncoder(args, videoEncoder);
      args.push('-pix_fmt', 'yuv420p');
      const scale = "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
      const filter = hdr
        ? `zscale=transfer=linear:npl=100,tonemap=tonemap=mobius:desat=0,zscale=transfer=bt709:matrix=bt709:primaries=bt709,${scale},format=yuv420p`
        : `${scale},format=yuv420p`;
      args.push('-vf', filter);
    } else {
      args.push('-vn');
    }
    if (audio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
    args.push('-sn');
  } else {
    args.push('-map', '0', '-c', 'copy');
  }

  const playlist = path.join(outputDir, 'index.m3u8');
  args.push(
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', isLive ? '8' : '0',
    '-hls_flags', isLive ? 'delete_segments+append_list+independent_segments' : 'independent_segments+temp_file',
    '-hls_segment_type', streams ? 'fmp4' : 'mpegts',
    '-hls_segment_filename', path.join(outputDir, streams ? 'segment_%06d.m4s' : 'segment_%06d.ts'),
    playlist,
  );
  return args;
}

export function buildRemuxArgs(options) {
  return hlsArgs(options);
}

export function buildConversionArgs(options) {
  return hlsArgs(options);
}

export function spawnManaged(childPath, args, session) {
  const child = spawn(childPath, args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  session.children.add(child);
  const closed = once(child, 'close').then(([code, signal]) => {
    session.children.delete(child);
    return { code, signal };
  });
  return { child, closed };
}

export async function stopChild(child, graceMs = 1_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'close').catch(() => {});
  child.kill('SIGTERM');
  const timer = new Promise((resolve) => setTimeout(() => resolve('timeout'), graceMs));
  timer.unref?.();
  if (await Promise.race([exited.then(() => 'closed'), timer]) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}
