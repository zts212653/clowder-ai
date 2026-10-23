import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FEATURE_DEMOS, getFeatureDemo, validateCapabilityTipInventory } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { syncFeatureDemoAssets } from '../../../scripts/sync-vendor-assets.mjs';
import tips from '../capability-tips.seed.json';

describe('F331 catalogue consumers', () => {
  it('keeps the real seed and demo catalogue in agreement in both directions', () => {
    for (const tip of tips) {
      if (!tip.demoId) continue;
      expect(getFeatureDemo(tip.demoId)?.tipId).toBe(tip.id);
    }
    for (const [id, demo] of Object.entries(FEATURE_DEMOS))
      expect(tips.find((tip) => tip.id === demo.tipId)?.demoId).toBe(id);
  });

  it('rejects misspelled demo IDs and bindings to a different tip before rendering or counting', () => {
    const tip = tips.find((value) => value.id === 'capability-propose-thread');
    expect(validateCapabilityTipInventory([{ ...tip, demoId: 'conversation-proposal-v1' }]).success).toBe(false);
    expect(validateCapabilityTipInventory([{ ...tip, id: 'a-different-tip' }]).success).toBe(false);
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
