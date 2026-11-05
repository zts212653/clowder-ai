import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { type ImmutableMedia, immutableMediaSchema, type ReviewedMediaType } from '@cat-cafe/shared';
import { z } from 'zod';
import { MediaOwnerError } from './media-errors.js';
import { probeImmutableImage } from './published-image-probe.js';
import { verifiedVideoFrameRate } from './published-media-frame-rate.js';

const videoStreamSchema = z.object({
  index: z.number().int().min(0).max(64),
  id: z.string().min(1),
  codec_type: z.literal('video'),
  codec_name: z.string().min(1),
  field_order: z.string().optional(),
  nb_frames: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  // ffprobe legitimately omits this for square-pixel MP4s (or emits N/A).
  // Treat that absence as 1:1, while malformed explicit rationals still fail below.
  sample_aspect_ratio: z
    .string()
    .optional()
    .transform((value) => (value && value !== 'N/A' ? value : '1:1')),
  time_base: z.string(),
  start_pts: z.number().int().safe(),
  duration_ts: z.number().int().positive().safe(),
  side_data_list: z.array(z.object({ rotation: z.number().finite().optional() })).optional(),
  disposition: z.object({ attached_pic: z.number() }).optional(),
});
const videoProbeSchema = z.object({
  format: z.object({ format_name: z.string(), start_time: z.string() }),
  streams: z.array(z.unknown()).max(64),
  packets: z.array(z.unknown()).max(250000).optional(),
});

export async function probeImmutableMedia(bytes: Buffer, mediaType: ReviewedMediaType): Promise<ImmutableMedia> {
  if (mediaType !== 'video/mp4') return probeImmutableImage(bytes, mediaType);
  if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp')
    throw new MediaOwnerError('invalid_media');
  return probeVideo(bytes);
}

/** Only accepts a server-owned immutable snapshot, never a caller-supplied locator or URL. */
export async function probeImmutableVideoFile(path: string): Promise<Extract<ImmutableMedia, { kind: 'video' }>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.subarray(4, 8).toString('ascii') !== 'ftyp')
      throw new MediaOwnerError('invalid_media');
  } finally {
    await handle.close();
  }
  return probeVideo(path);
}

async function probeVideo(source: Buffer | string): Promise<Extract<ImmutableMedia, { kind: 'video' }>> {
  const media = parseVideoProbe(await runVideoProbe(source));
  // Frame-clock enrichment is optional: an oversized packet audit must not reject previously supported video.
  try {
    // Reuse the codec/field-order fence as well as the complete presentation-clock audit.
    const enriched = parseVideoProbe(await runVideoProbe(source, true));
    return enriched.frameRate ? { ...media, frameRate: enriched.frameRate } : media;
  } catch {
    return media;
  }
}

/** Read the container's stream clock and display transform. Frame-rate guesses are deliberately absent. */
export function parseVideoProbe(raw: unknown): Extract<ImmutableMedia, { kind: 'video' }> {
  try {
    const probe = videoProbeSchema.parse(raw);
    if (!probe.format.format_name.split(',').includes('mp4')) throw new Error('not MP4');
    const streams = probe.streams.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object' || (candidate as Record<string, unknown>).codec_type !== 'video')
        return [];
      const parsed = videoStreamSchema.parse(candidate);
      return parsed.disposition?.attached_pic ? [] : [parsed];
    });
    const stream = streams[0];
    if (streams.length !== 1 || !stream) throw new Error('ambiguous video stream');
    const rotations = (stream.side_data_list ?? []).flatMap((entry) =>
      entry.rotation === undefined ? [] : [entry.rotation],
    );
    if (rotations.length > 1) throw new Error('ambiguous display transform');
    const rotation = (((rotations[0] ?? 0) % 360) + 360) % 360;
    const pixelAspectRatio = parseRational(stream.sample_aspect_ratio, ':');
    const timebase = parseRational(stream.time_base, '/');
    const displayWidth = Math.round((stream.width * pixelAspectRatio.numerator) / pixelAspectRatio.denominator);
    const rotated = rotation === 90 || rotation === 270;
    const singleFramePackets = ['h264', 'hevc'].includes(stream.codec_name) && stream.field_order === 'progressive';
    const frameRate = singleFramePackets
      ? verifiedVideoFrameRate({
          packets: probe.packets,
          expectedFrameCount: Number(stream.nb_frames),
          streamIndex: stream.index,
          startPts: stream.start_pts,
          durationPts: stream.duration_ts,
          timebase,
        })
      : undefined;
    const media = immutableMediaSchema.parse({
      kind: 'video',
      width: rotated ? stream.height : displayWidth,
      height: rotated ? displayWidth : stream.height,
      codedWidth: stream.width,
      codedHeight: stream.height,
      rotation,
      pixelAspectRatio,
      streamId: `${stream.index}:${stream.id}`,
      streamIndex: stream.index,
      timebase,
      startTick: stream.start_pts,
      durationTicks: stream.duration_ts,
      containerStartSeconds: Number(probe.format.start_time),
      ...(frameRate ? { frameRate } : {}),
    });
    if (media.kind !== 'video' || !Number.isSafeInteger(media.startTick + media.durationTicks))
      throw new Error('invalid video clock');
    return media;
  } catch {
    throw new MediaOwnerError('invalid_media');
  }
}

function parseRational(value: string, separator: string) {
  const components = value.split(separator);
  if (components.length !== 2) throw new Error('invalid rational');
  const numerator = Number(components[0]);
  const denominator = Number(components[1]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0)
    throw new Error('invalid rational');
  return { numerator, denominator };
}

function runVideoProbe(source: Buffer | string, includePackets = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Snapshot files are private server paths; MOV cannot open external track references or playlists.
    const child = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-max_alloc',
        '67108864',
        '-protocol_whitelist',
        typeof source === 'string' ? 'file' : 'pipe',
        '-probesize',
        '10485760',
        '-analyzeduration',
        '10000000',
        '-threads',
        '1',
        '-f',
        'mov',
        '-enable_drefs',
        '0',
        '-use_absolute_path',
        '0',
        '-select_streams',
        'V',
        ...(includePackets ? ['-show_packets', '-show_entries', 'stream:format:packet=pts,duration,stream_index'] : []),
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        '-i',
        typeof source === 'string' ? source : 'pipe:0',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    let outputSize = 0;
    let settled = false;
    const finish = (error?: MediaOwnerError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new MediaOwnerError('media_unavailable'));
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputSize += Buffer.byteLength(chunk);
      if (outputSize > (includePackets ? 16 * 1024 * 1024 : 512 * 1024)) {
        child.kill('SIGKILL');
        finish(new MediaOwnerError('invalid_media'));
        return;
      }
      output += chunk;
    });
    child.stderr.resume();
    child.stdin.on('error', () => {
      /* Process exit supplies the canonical failure; no unhandled EPIPE. */
    });
    child.on('error', () => finish(new MediaOwnerError('media_unavailable')));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new MediaOwnerError('invalid_media'));
        return;
      }
      try {
        finish(undefined, JSON.parse(output) as unknown);
      } catch {
        finish(new MediaOwnerError('invalid_media'));
      }
    });
    child.stdin.end(typeof source === 'string' ? undefined : source);
  });
}
