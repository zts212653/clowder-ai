import { spawn } from 'node:child_process';
import type { ImmutableMedia } from '@cat-cafe/shared';
import sharp from 'sharp';
import { MediaOwnerError } from './media-errors.js';

/** Original bytes remain F311-owned. Normalization produces a separately identified, explicit derivative only. */
export async function normalizeEvolutionSnapshot(
  bytes: Buffer,
  mime: string,
  media: ImmutableMedia,
): Promise<{ bytes: Buffer; mediaType: 'image/png' | 'video/mp4' }> {
  if (mime === 'image/png' || mime === 'video/mp4') return { bytes, mediaType: mime };
  if (mime === 'image/jpeg' || mime === 'image/webp')
    return {
      bytes: await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).rotate().png().toBuffer(),
      mediaType: 'image/png',
    };
  if (mime !== 'video/webm' || media.kind !== 'video') throw new MediaOwnerError('invalid_media');
  return {
    bytes: await normalizeWebm(bytes, (media.startTick * media.timebase.numerator) / media.timebase.denominator),
    mediaType: 'video/mp4',
  };
}

function normalizeWebm(bytes: Buffer, startSeconds: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // No URLs, paths or shell input; preserve variable presentation times while rebasing the new clip to zero.
    const child = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-max_alloc',
        '67108864',
        '-protocol_whitelist',
        'pipe',
        '-threads',
        '1',
        '-copyts',
        '-f',
        'matroska',
        '-i',
        'pipe:0',
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-vf',
        `setpts=PTS-(${startSeconds})/TB,scale=ceil(iw*sar/2)*2:ceil(ih/2)*2,setsar=1`,
        '-af',
        `asetpts=PTS-(${startSeconds})/TB`,
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-preset',
        'fast',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-fps_mode',
        'passthrough',
        '-bf',
        '0',
        '-c:a',
        'aac',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
        '-f',
        'mp4',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let size = 0,
      settled = false;
    const finish = (error?: MediaOwnerError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, size));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new MediaOwnerError('media_unavailable'));
    }, 45_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new MediaOwnerError('invalid_media'));
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new MediaOwnerError('media_unavailable')));
    child.on('close', (code) => finish(code === 0 ? undefined : new MediaOwnerError('invalid_media')));
    child.stdin.end(bytes);
  });
}
