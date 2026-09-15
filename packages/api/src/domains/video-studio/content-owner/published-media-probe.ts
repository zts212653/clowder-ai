import { spawn } from 'node:child_process';
import { type ImmutableMedia, immutableMediaSchema } from '@cat-cafe/shared';
import sharp from 'sharp';
import { z } from 'zod';
import { MediaOwnerError } from './media-errors.js';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const videoStreamSchema = z.object({
  index: z.number().int().min(0).max(64),
  id: z.string().min(1),
  codec_type: z.literal('video'),
  codec_name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sample_aspect_ratio: z.string(),
  time_base: z.string(),
  start_pts: z.number().int().safe(),
  duration_ts: z.number().int().positive().safe(),
  side_data_list: z.array(z.object({ rotation: z.number().finite().optional() })).optional(),
  disposition: z.object({ attached_pic: z.number() }).optional(),
});
const videoProbeSchema = z.object({
  format: z.object({ format_name: z.string(), start_time: z.string() }),
  streams: z.array(z.unknown()).max(64),
});

export async function probeImmutableMedia(
  bytes: Buffer,
  mediaType: 'image/png' | 'video/mp4',
): Promise<ImmutableMedia> {
  if (mediaType === 'image/png') {
    if (!bytes.subarray(0, 8).equals(pngSignature)) throw new MediaOwnerError('invalid_media');
    try {
      const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' });
      const metadata = await decoder.metadata();
      if (
        metadata.format !== 'png' ||
        (metadata.pages && metadata.pages > 1) ||
        (metadata.orientation && metadata.orientation !== 1)
      ) {
        throw new MediaOwnerError('invalid_media');
      }
      await decoder.stats();
      return immutableMediaSchema.parse({ kind: 'image', width: metadata.width, height: metadata.height });
    } catch {
      throw new MediaOwnerError('invalid_media');
    }
  }
  if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp')
    throw new MediaOwnerError('invalid_media');
  return parseVideoProbe(await runVideoProbe(bytes));
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

function runVideoProbe(bytes: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Pipe-only input and demuxer restriction prevent URLs, playlists and external file references in an upload.
    const child = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-max_alloc',
        '67108864',
        '-protocol_whitelist',
        'pipe',
        '-probesize',
        '10485760',
        '-analyzeduration',
        '10000000',
        '-threads',
        '1',
        '-f',
        'mov',
        '-select_streams',
        'V',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        '-i',
        'pipe:0',
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
      if (outputSize > 512 * 1024) {
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
    child.stdin.end(bytes);
  });
}
