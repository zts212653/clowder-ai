import { spawn } from 'node:child_process';
import { type ImmutableMedia, immutableMediaSchema } from '@cat-cafe/shared';
import sharp from 'sharp';
import { z } from 'zod';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import { probeImmutableMedia } from '../../video-studio/content-owner/published-media-probe.js';

export async function probeEvolutionMedia(bytes: Buffer, mime: string): Promise<ImmutableMedia> {
  if (mime === 'image/png' || mime === 'video/mp4') return probeImmutableMedia(bytes, mime);
  if (mime === 'image/jpeg' || mime === 'image/webp') {
    const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' });
    const metadata = await decoder.metadata();
    if (metadata.format !== mime.slice(6) || (metadata.pages ?? 1) !== 1) throw new MediaOwnerError('invalid_media');
    const { info } = await decoder.rotate().png().toBuffer({ resolveWithObject: true });
    return immutableMediaSchema.parse({ kind: 'image', width: info.width, height: info.height });
  }
  if (mime !== 'video/webm') throw new MediaOwnerError('invalid_media');
  return parseWebmClock(await readWebmProbe(bytes));
}

const tick = z.number().int().safe(),
  positive = z.number().int().positive().safe();
const stream = z.object({
  index: tick.nonnegative(),
  codec_type: z.literal('video'),
  width: positive,
  height: positive,
  time_base: z.string(),
  sample_aspect_ratio: z.string().optional(),
  disposition: z.object({ attached_pic: z.number() }).optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
});
const probe = z.object({
  format: z.object({ format_name: z.string(), start_time: z.string() }),
  streams: z.array(stream).min(1).max(64),
  packets: z
    .array(z.object({ stream_index: tick.nonnegative(), pts: tick, duration: positive }))
    .min(1)
    .max(200_000),
});

/** WebM has no mandatory stream duration/id. Actual packet PTS and duration supply the clock, never FPS. */
export function parseWebmClock(raw: unknown): Extract<ImmutableMedia, { kind: 'video' }> {
  try {
    const data = probe.parse(raw),
      streams = data.streams.filter((item) => !item.disposition?.attached_pic);
    const selected = streams[0];
    if (!data.format.format_name.split(',').includes('webm') || streams.length !== 1 || !selected)
      throw new Error('ambiguous stream');
    if (data.packets.some((packet) => packet.stream_index !== selected.index)) throw new Error('foreign packet');
    const startTick = data.packets.reduce((start, packet) => Math.min(start, packet.pts), Number.POSITIVE_INFINITY);
    const endTick = data.packets.reduce((end, packet) => Math.max(end, packet.pts + packet.duration), startTick);
    const timebase = rational(selected.time_base, '/');
    const pixelAspectRatio = rational(
      selected.sample_aspect_ratio && selected.sample_aspect_ratio !== 'N/A' ? selected.sample_aspect_ratio : '1:1',
      ':',
    );
    const rotations = (selected.side_data_list ?? []).flatMap((item) =>
      item.rotation === undefined ? [] : [item.rotation],
    );
    if (rotations.length > 1) throw new Error('ambiguous transform');
    const rotation = (((rotations[0] ?? 0) % 360) + 360) % 360;
    const width = Math.round((selected.width * pixelAspectRatio.numerator) / pixelAspectRatio.denominator);
    const rotated = rotation === 90 || rotation === 270;
    const media = immutableMediaSchema.parse({
      kind: 'video',
      width: rotated ? selected.height : width,
      height: rotated ? width : selected.height,
      codedWidth: selected.width,
      codedHeight: selected.height,
      rotation,
      pixelAspectRatio,
      streamId: 'webm:' + selected.index,
      streamIndex: selected.index,
      timebase,
      startTick,
      durationTicks: endTick - startTick,
      containerStartSeconds: Number(data.format.start_time),
    });
    if (media.kind !== 'video' || !Number.isSafeInteger(endTick)) throw new Error('invalid clock');
    return media;
  } catch {
    throw new MediaOwnerError('invalid_media');
  }
}

function rational(value: string, separator: string) {
  const pieces = value.split(separator),
    numerator = Number(pieces[0]),
    denominator = Number(pieces[1]);
  if (
    pieces.length !== 2 ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  )
    throw new Error('invalid rational');
  return { numerator, denominator };
}

function readWebmProbe(bytes: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-max_alloc',
        '67108864',
        '-protocol_whitelist',
        'pipe',
        '-f',
        'matroska',
        '-select_streams',
        'V',
        '-show_streams',
        '-show_format',
        '-show_packets',
        '-show_entries',
        'stream=index,codec_type,width,height,time_base,sample_aspect_ratio:stream_disposition=attached_pic:stream_side_data=rotation:format=format_name,start_time:packet=stream_index,pts,duration',
        '-of',
        'json',
        '-i',
        'pipe:0',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '',
      size = 0,
      settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new MediaOwnerError('media_unavailable'));
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 16 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new MediaOwnerError('invalid_media'));
        return;
      }
      output += chunk;
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new MediaOwnerError('media_unavailable')));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new MediaOwnerError('invalid_media'));
        return;
      }
      try {
        finish(undefined, JSON.parse(output));
      } catch {
        finish(new MediaOwnerError('invalid_media'));
      }
    });
    child.stdin.end(bytes);
  });
}
