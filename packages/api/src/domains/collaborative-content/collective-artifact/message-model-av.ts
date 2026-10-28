import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CollectiveContextAttachmentSelection,
  CollectiveMessageAttachment,
  CollectiveModelImage,
  CollectiveModelMedia,
} from '@cat-cafe/shared';
import sharp from 'sharp';
import { z } from 'zod';
import { modelMediaInput, runModelMediaTool } from './message-model-media-file.js';

export type CollectiveAudioTranscriber = (request: {
  audioPath: string;
  signal: AbortSignal;
}) => Promise<{ text: string; provider: string } | undefined>;
const probeSchema = z.object({
  streams: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        codec_type: z.string(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      }),
    )
    .max(64),
  format: z.object({ duration: z.string().optional() }),
});
type Probe = z.infer<typeof probeSchema>;
const demuxers: Readonly<Record<string, string>> = {
  'video/mp4': 'mov',
  'video/webm': 'matroska',
  'video/ogg': 'ogg',
  'audio/mp4': 'mov',
  'audio/webm': 'matroska',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
};
export const modelMediaDemuxer = (mime: string) => demuxers[mime];

async function probe(path: string, format: string, signal: AbortSignal) {
  const bytes = await runModelMediaTool(
    'ffprobe',
    path,
    [
      ...modelMediaInput(format),
      '-show_entries',
      'stream=index,codec_type,width,height:format=duration',
      '-of',
      'json',
    ],
    signal,
    512 * 1024,
  );
  return probeSchema.parse(JSON.parse(bytes.toString('utf8')));
}
function duration(value: Probe) {
  const seconds = Number(value.format.duration);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

async function speech(
  path: string,
  directory: string,
  format: string,
  metadata: Probe,
  selection: CollectiveContextAttachmentSelection,
  signal: AbortSignal,
  transcribe?: CollectiveAudioTranscriber,
) {
  const stream = metadata.streams.find((item) => item.codec_type === 'audio');
  if (!stream) return undefined;
  if (!transcribe) return undefined;
  const startSeconds = selection.startSeconds ?? 0;
  const seconds = selection.durationSeconds ?? 30;
  const wav = await runModelMediaTool(
    'ffmpeg',
    path,
    [
      ...modelMediaInput(format, startSeconds),
      '-map',
      '0:a:0',
      '-t',
      String(seconds),
      '-threads',
      '1',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      'pipe:1',
    ],
    signal,
    4 * 1024 * 1024,
  );
  const audioPath = join(directory, 'analysis.wav');
  await writeFile(audioPath, wav, { mode: 0o600, flag: 'wx' });
  const decoded = duration(await probe(audioPath, 'wav', signal));
  if (!decoded) throw new Error('The selected audio window has no decodable samples');
  const result = await transcribe({ audioPath, signal });
  if (!result) return undefined;
  const total = duration(metadata);
  return {
    transcript: result.text.slice(0, 32_000),
    provider: result.provider,
    startSeconds,
    durationSeconds: decoded,
    ...(total ? { totalDurationSeconds: total } : {}),
    truncated: startSeconds > 0 || !total || startSeconds + decoded + 0.02 < total || result.text.length > 32_000,
  };
}

export async function readModelAv(
  attachment: CollectiveMessageAttachment,
  path: string,
  directory: string,
  selection: CollectiveContextAttachmentSelection,
  signal: AbortSignal,
  transcribe?: CollectiveAudioTranscriber,
): Promise<CollectiveModelMedia['content']> {
  const format = modelMediaDemuxer(attachment.mediaType);
  if (!format) return { type: 'unavailable', reason: 'unsupported_format' };
  const metadata = await probe(path, format, signal);
  const total = duration(metadata);
  const start = selection.startSeconds ?? 0;
  if (total && start >= total) throw new Error('Requested media position is outside this attachment');
  if (attachment.mediaType.startsWith('audio/')) {
    const text = await speech(path, directory, format, metadata, selection, signal, transcribe);
    return text ? { type: 'audio', ...text } : { type: 'unavailable', reason: 'transcription_unavailable' };
  }
  const video = metadata.streams.find((item) => item.codec_type === 'video');
  if (!video?.width || !video.height || video.width * video.height > 40_000_000)
    throw new Error('Published video exceeds the model pixel budget');
  const ratio = Math.min(1, 1024 / video.width, 1024 / video.height);
  const jpeg = await runModelMediaTool(
    'ffmpeg',
    path,
    [
      ...modelMediaInput(format, start),
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-threads',
      '1',
      '-vf',
      `scale=${Math.max(1, Math.floor(video.width * ratio))}:${Math.max(1, Math.floor(video.height * ratio))}`,
      '-q:v',
      '5',
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ],
    signal,
    4 * 1024 * 1024,
  );
  let frame: CollectiveModelImage | undefined;
  for (const edge of [1024, 512]) {
    const encoded = await sharp(jpeg, { limitInputPixels: 40_000_000, failOn: 'error' })
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer({ resolveWithObject: true });
    if (encoded.data.length <= 256 * 1024) {
      frame = {
        kind: 'collective_model_image',
        v: 1,
        attachmentId: attachment.attachmentId,
        sourceDigest: attachment.blobDigest,
        mediaType: 'image/jpeg',
        dataBase64: encoded.data.toString('base64'),
        width: encoded.info.width,
        height: encoded.info.height,
        originalWidth: video.width,
        originalHeight: video.height,
        transformed: true,
      };
      break;
    }
  }
  if (!frame) throw new Error('Video sample exceeds the native response budget');
  const text = await speech(path, directory, format, metadata, selection, signal, transcribe);
  return {
    type: 'video',
    atSeconds: start,
    ...(total ? { durationSeconds: total } : {}),
    frame,
    audio: !metadata.streams.some((item) => item.codec_type === 'audio')
      ? { status: 'none' }
      : text
        ? { status: 'transcribed', ...text }
        : { status: 'unavailable', reason: 'transcription_unavailable' },
  };
}
