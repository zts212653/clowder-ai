import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CapabilityTip,
  FEATURE_DEMOS,
  getFeatureDemoIdForTip,
  validateCapabilityTipInventory,
} from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { mp4DurationSeconds, pinFeatureDemos } from '../../../../../scripts/pin-feature-demos.mjs';
import { syncFeatureDemoAssets } from '../../../scripts/sync-vendor-assets.mjs';
import { canRenderInTipStrip } from '../../components/CapabilityTipStrip';
import {
  DEFAULT_STREAMING_TIP_CONTEXTS,
  REVIEW_STREAMING_TIP_CONTEXTS,
} from '../../components/capability-tip-placement';
import tips from '../capability-tips.seed.json';

const repoRoot = join(__dirname, '../../../../..');
const WAITING_CONTEXTS = new Set<string>([...DEFAULT_STREAMING_TIP_CONTEXTS, ...REVIEW_STREAMING_TIP_CONTEXTS]);

/** Smallest MP4 the pin script can read: an ftyp box and a moov box holding a version-0 or version-1 mvhd. */
function fakeMp4(timescale: number, duration: number, extra = '', version: 0 | 1 = 0) {
  const mvhd = Buffer.alloc(8 + (version === 1 ? 112 : 100));
  mvhd.writeUInt32BE(mvhd.length, 0);
  mvhd.write('mvhd', 4, 'latin1');
  mvhd.writeUInt8(version, 8);
  if (version === 1) {
    mvhd.writeUInt32BE(timescale, 8 + 20);
    mvhd.writeBigUInt64BE(BigInt(duration), 8 + 24);
  } else {
    mvhd.writeUInt32BE(timescale, 8 + 12);
    mvhd.writeUInt32BE(duration, 8 + 16);
  }
  const moov = Buffer.concat([Buffer.from([0, 0, 0, 8 + mvhd.length]), Buffer.from('moov', 'latin1'), mvhd]);
  const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from(`ftypisom${extra.padEnd(4, ' ')}`, 'latin1')]);
  return Buffer.concat([ftyp, moov]);
}

describe('F331 catalogue consumers', () => {
  it('attaches every film to one real tip that the waiting strip can show', () => {
    const claimed = new Set<string>();
    for (const [id, demo] of Object.entries(FEATURE_DEMOS)) {
      const tip = tips.find((value) => value.id === demo.tipId);
      expect(tip, `${id} points at a tip that does not exist`).toBeDefined();
      expect(
        tip?.contexts.some((context) => WAITING_CONTEXTS.has(context)),
        `${id}: ${demo.tipId} never shows while a cat is working, so its film cannot be watched`,
      ).toBe(true);
      expect(
        canRenderInTipStrip(tip as CapabilityTip),
        `${id}: ${demo.tipId} has a ${tip?.action.type} action, which the waiting strip never shows`,
      ).toBe(true);
      expect(claimed.has(demo.tipId), `${demo.tipId} has two films`).toBe(false);
      claimed.add(demo.tipId);
      expect(getFeatureDemoIdForTip(demo.tipId)).toBe(id);
    }
  });

  it('keeps every film in feature-demos.json pinned to the cut that ships', () => {
    expect(pinFeatureDemos({ repoRoot, write: false })).toEqual({ errors: [], pinned: [] });
    for (const demo of Object.values(FEATURE_DEMOS)) {
      expect(demo.durationSeconds).toBeGreaterThan(0);
      expect(demo.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('pins a new film, refuses a changed published cut, and reports missing files', () => {
    const root = mkdtempSync(join(tmpdir(), 'f331-pin-'));
    const catalogue = join(root, 'packages/shared/src/feature-demos.json');
    const asset = (name: string) => join(root, 'site/assets/demos', name);
    const entry = { tipId: 'tip-a', title: 'A', video: 'a.zh.mp4', poster: 'a.jpg', tryPrompt: '试一下' };
    try {
      mkdirSync(dirname(catalogue), { recursive: true });
      mkdirSync(dirname(asset('a.zh.mp4')), { recursive: true });
      writeFileSync(asset('a.zh.mp4'), fakeMp4(1000, 36_500));
      writeFileSync(asset('a.jpg'), 'poster');
      writeFileSync(catalogue, JSON.stringify({ 'a-v1': entry }));
      expect(mp4DurationSeconds(readFileSync(asset('a.zh.mp4')))).toBe(36.5);
      expect(pinFeatureDemos({ repoRoot: root })).toEqual({ errors: [], pinned: ['a-v1'] });
      const pinned = JSON.parse(readFileSync(catalogue, 'utf8'))['a-v1'];
      expect(pinned.durationSeconds).toBe(36.5);
      expect(pinned.sha256).toBe(
        createHash('sha256')
          .update(readFileSync(asset('a.zh.mp4')))
          .digest('hex'),
      );
      expect(pinFeatureDemos({ repoRoot: root })).toEqual({ errors: [], pinned: [] });

      writeFileSync(asset('a.zh.mp4'), fakeMp4(1000, 36_500, 'cut2'));
      const changed = pinFeatureDemos({ repoRoot: root });
      expect(changed.errors[0]).toMatch(/a-v1: a\.zh\.mp4 changed after it was published.*as a-v2 without sha256/);
      expect(JSON.parse(readFileSync(catalogue, 'utf8'))['a-v1'].sha256).toBe(pinned.sha256);

      writeFileSync(catalogue, JSON.stringify({ 'b-v1': { ...entry, video: 'b.zh.mp4' } }));
      expect(pinFeatureDemos({ repoRoot: root }).errors).toEqual(['b-v1: site/assets/demos/b.zh.mp4 not found']);

      writeFileSync(asset('c.zh.mp4'), fakeMp4(600, 4_800, '', 1));
      writeFileSync(catalogue, JSON.stringify({ 'c-v2': { ...entry, video: 'c.zh.mp4', durationSeconds: 99 } }));
      expect(pinFeatureDemos({ repoRoot: root }).errors).toEqual([
        'c-v2: durationSeconds 99 does not match c.zh.mp4 (8)',
      ]);
      writeFileSync(catalogue, JSON.stringify({ 'c-v2': { ...entry, video: 'c.zh.mp4', sha256: 'stale' } }));
      expect(pinFeatureDemos({ repoRoot: root }).errors[0]).toMatch(/add the new cut as c-v3/);
      writeFileSync(catalogue, JSON.stringify({ 'd-v1': { ...entry, video: 'd' } }));
      expect(pinFeatureDemos({ repoRoot: root }).errors).toEqual([
        'd-v1: video must be an .mp4 file name in site/assets/demos',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps demo references out of tips: a film is attached only in feature-demos.json', () => {
    const tip = tips.find((value) => value.id === 'capability-propose-thread');
    expect(validateCapabilityTipInventory([{ ...tip, demoId: 'conversation-proposals-v1' }]).success).toBe(false);
  });

  it('publishes every catalogue entry and verifies the second film hash too', () => {
    const root = mkdtempSync(join(tmpdir(), 'f331-catalog-'));
    const publicRoot = join(root, 'public');
    const first = FEATURE_DEMOS['conversation-proposals-v1'];
    const firstBytes = Buffer.from('first published film');
    const secondBytes = Buffer.from('second published film');
    const demos = {
      'conversation-proposals-v1': { ...first, sha256: createHash('sha256').update(firstBytes).digest('hex') },
      'second-film-v1': {
        ...first,
        assetSource: 'site/assets/demos/second.mp4',
        posterAssetSource: 'site/assets/demos/second.jpg',
        src: '/vendor/demos/second-film-v1.mp4',
        poster: '/vendor/demos/second-film-v1.jpg',
        sha256: createHash('sha256').update(secondBytes).digest('hex'),
      },
    };
    try {
      for (const [path, bytes] of [
        [first.assetSource, firstBytes],
        ['site/assets/demos/conversation-proposals.jpg', Buffer.from('first poster')],
        ['site/assets/demos/second.mp4', secondBytes],
        ['site/assets/demos/second.jpg', Buffer.from('second poster')],
      ] as const) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), bytes);
      }
      syncFeatureDemoAssets({ demos, repoRoot: root, publicRoot });
      expect(existsSync(join(publicRoot, demos['second-film-v1'].src))).toBe(true);
      expect(readFileSync(join(publicRoot, demos['second-film-v1'].src))).toEqual(secondBytes);
      expect(readFileSync(join(publicRoot, demos['second-film-v1'].poster), 'utf8')).toBe('second poster');
      writeFileSync(join(root, demos['second-film-v1'].assetSource), 'changed cut');
      expect(() => syncFeatureDemoAssets({ demos, repoRoot: root, publicRoot })).toThrow(
        /Published demo bytes changed/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
