import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { mapDerivedMediaAnchor } from '../src/domains/collaborative-content/modification/derived-media-anchor.js';
import {
  parseWebmClock,
  probeEvolutionMedia,
} from '../src/domains/collaborative-content/workspace-review/evolution-media-probe.js';
import { normalizeEvolutionSnapshot } from '../src/domains/video-studio/content-owner/evolution-snapshot-media.js';

test('archived JPEG/WebP geometry follows the actual displayed orientation, without modifying source bytes', async () => {
  const original = sharp({ create: { width: 160, height: 100, channels: 3, background: 'blue' } });
  const jpeg = await original.clone().jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const copy = Buffer.from(jpeg);
  assert.deepEqual(await probeEvolutionMedia(jpeg, 'image/jpeg'), { kind: 'image', width: 100, height: 160 });
  assert.deepEqual(jpeg, copy);
  const normalized = await normalizeEvolutionSnapshot(
    jpeg,
    'image/jpeg',
    await probeEvolutionMedia(jpeg, 'image/jpeg'),
  );
  assert.equal(normalized.mediaType, 'image/png');
  assert.deepEqual(await probeEvolutionMedia(normalized.bytes, 'image/png'), {
    kind: 'image',
    width: 100,
    height: 160,
  });
  assert.deepEqual(jpeg, copy);
  const webp = await original.clone().webp().toBuffer();
  assert.deepEqual(await probeEvolutionMedia(webp, 'image/webp'), { kind: 'image', width: 160, height: 100 });
  await assert.rejects(probeEvolutionMedia(webp, 'image/jpeg'), /invalid_media/);
});

test('WebM ranges derive from actual packet ticks, not duration tags or a guessed frame rate', () => {
  const raw = {
    format: { format_name: 'matroska,webm', start_time: '0.012' },
    streams: [{ index: 0, codec_type: 'video', width: 160, height: 100, time_base: '1/1000' }],
    packets: [
      { stream_index: 0, pts: 12, duration: 17 },
      { stream_index: 0, pts: 29, duration: 39 },
    ],
  };
  const media = parseWebmClock(raw);
  assert.equal(media.startTick, 12);
  assert.equal(media.durationTicks, 56);
  assert.deepEqual(media.timebase, { numerator: 1, denominator: 1000 });
  assert.throws(
    () => parseWebmClock({ ...raw, packets: [{ stream_index: 0, pts: 12, duration: 0 }] }),
    /invalid_media/,
  );
  assert.throws(
    () => parseWebmClock({ ...raw, streams: [...raw.streams, { ...raw.streams[0], index: 1 }] }),
    /invalid_media/,
  );
});

test('a real archived WebM supplies its exact clock through a bounded pipe-only probe', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-evolution-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'original.webm');
  await promisify(execFile)(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x100:r=25:d=0.16', '-c:v', 'libvpx-vp9', path],
    { timeout: 15_000 },
  );
  const bytes = await readFile(path),
    original = Buffer.from(bytes);
  const media = await probeEvolutionMedia(bytes, 'video/webm');
  assert.equal(media.kind, 'video');
  if (media.kind !== 'video') throw new Error('expected video');
  assert.deepEqual(media.timebase, { numerator: 1, denominator: 1000 });
  assert.equal(media.durationTicks, 160);
  const normalized = await normalizeEvolutionSnapshot(bytes, 'video/webm', media);
  const next = await probeEvolutionMedia(normalized.bytes, 'video/mp4');
  assert.equal(next.kind, 'video');
  if (next.kind !== 'video') throw new Error('expected derived video');
  assert.notEqual(next.streamId, media.streamId);
  const anchor = mapDerivedMediaAnchor(
    {
      kind: 'video-range',
      streamId: media.streamId,
      startTick: 40,
      endTick: 120,
      framePoint: { tick: 80, x: 20, y: 30 },
    },
    media,
    next,
  );
  assert.equal(anchor.kind, 'video-range');
  if (anchor.kind !== 'video-range') throw new Error('expected range');
  assert.equal(anchor.streamId, next.streamId);
  assert.equal(((anchor.startTick - next.startTick) * next.timebase.numerator) / next.timebase.denominator, 0.04);
  assert.equal(((anchor.endTick - next.startTick) * next.timebase.numerator) / next.timebase.denominator, 0.12);
  assert.equal(
    ((anchor.framePoint!.tick - next.startTick) * next.timebase.numerator) / next.timebase.denominator,
    0.08,
  );
  assert.deepEqual(bytes, original, 'normalization is only a new derivative, never an original-owner write');
});
