import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  parseVideoProbe,
  probeImmutableMedia,
} from '../src/domains/video-studio/content-owner/published-media-probe.js';

test('source dimensions come from actual PNG bytes, not the filename or client width', async () => {
  const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#f5edda' } })
    .png()
    .toBuffer();
  assert.deepEqual(await probeImmutableMedia(bytes, 'image/png'), { kind: 'image', width: 800, height: 600 });
  await assert.rejects(probeImmutableMedia(Buffer.from('not a PNG'), 'image/png'), /invalid_media/);
  await assert.rejects(probeImmutableMedia(bytes, 'video/mp4'), /invalid_media/);
});

test('an actual mp4 yields stream identity and presentation ticks without assuming a frame rate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-video-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'sample.mp4');
  await promisify(execFile)(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x96:r=24:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      path,
    ],
    { timeout: 15000 },
  );
  const media = await probeImmutableMedia(await readFile(path), 'video/mp4');
  assert.equal(media.kind, 'video');
  if (media.kind !== 'video') return;
  assert.equal(media.width, 160);
  assert.equal(media.height, 96);
  assert.equal((media.durationTicks * media.timebase.numerator) / media.timebase.denominator, 1);
  assert.equal(media.streamId, '0:0x1');
  assert.equal(media.rotation, 0);
  assert.deepEqual(media.frameRate, { numerator: 24, denominator: 1 });
});

test('rotation and non-square pixels retain transform evidence; ambiguous streams and missing ticks fail closed', () => {
  const stream = {
    index: 0,
    id: '0x1',
    codec_type: 'video',
    codec_name: 'h264',
    width: 1920,
    height: 1080,
    sample_aspect_ratio: '1:1',
    time_base: '1/90000',
    start_pts: 9000,
    duration_ts: 180000,
    side_data_list: [{ rotation: -90 }],
    disposition: { attached_pic: 0 },
  };
  const probe = { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', start_time: '0.1' }, streams: [stream] };
  const media = parseVideoProbe(probe);
  assert.equal(media.width, 1080);
  assert.equal(media.height, 1920);
  assert.equal(media.rotation, 270);
  assert.equal(media.startTick, 9000);
  assert.deepEqual(media.timebase, { numerator: 1, denominator: 90000 });
  assert.equal(
    parseVideoProbe({ ...probe, streams: [{ ...stream, side_data_list: [], sample_aspect_ratio: '4:3' }] }).width,
    2560,
  );
  assert.equal(
    parseVideoProbe({ ...probe, streams: [{ ...stream, side_data_list: [], sample_aspect_ratio: undefined }] }).width,
    1920,
    'ordinary MP4s may omit sample_aspect_ratio; that means square pixels rather than an invalid source',
  );
  assert.throws(() => parseVideoProbe({ ...probe, streams: [stream, { ...stream, index: 1 }] }), /invalid_media/);
  assert.throws(() => parseVideoProbe({ ...probe, streams: [{ ...stream, duration_ts: undefined }] }), /invalid_media/);
});

test('verified frameRate comes from complete uniform packet PTS, while VFR or missing evidence stays unknown', () => {
  const stream = {
    index: 0,
    id: '0x1',
    codec_type: 'video',
    codec_name: 'h264',
    field_order: 'progressive',
    nb_frames: '3',
    width: 160,
    height: 96,
    sample_aspect_ratio: '1:1',
    time_base: '1/30',
    start_pts: 0,
    duration_ts: 3,
    disposition: { attached_pic: 0 },
  };
  const base = { format: { format_name: 'mp4', start_time: '0' }, streams: [stream] };
  const packets = [0, 2, 1].map((pts) => ({ stream_index: 0, pts, duration: 1 }));
  assert.deepEqual(parseVideoProbe({ ...base, packets }).frameRate, { numerator: 30, denominator: 1 });
  assert.equal(parseVideoProbe(base).frameRate, undefined);
  assert.equal(parseVideoProbe({ ...base, packets, streams: [{ ...stream, codec_name: 'vp9' }] }).frameRate, undefined);
  assert.equal(parseVideoProbe({ ...base, packets, streams: [{ ...stream, field_order: 'tt' }] }).frameRate, undefined);
  assert.equal(parseVideoProbe({ ...base, packets: packets.slice(1) }).frameRate, undefined);
  assert.equal(
    parseVideoProbe({
      ...base,
      streams: [{ ...stream, duration_ts: 4 }],
      packets: [
        { stream_index: 0, pts: 0, duration: 1 },
        { stream_index: 0, pts: 1, duration: 2 },
        { stream_index: 0, pts: 3, duration: 1 },
      ],
    }).frameRate,
    undefined,
  );
});
