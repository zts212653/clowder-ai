import { describe, expect, it } from 'vitest';
import { SCENES, VISIBLE_CAFE_ASSET_BASE, visibleCafeAssetUrl, XIANXIAN_SKIN } from '../asset-config';

describe('Visible Café asset ownership', () => {
  it('resolves the real scene, skin manifest and all atlas rows under the independent asset base', () => {
    expect(VISIBLE_CAFE_ASSET_BASE).toBe('/visible-cafe');
    expect(visibleCafeAssetUrl('skins/new-cat/skin.json')).toBe('/visible-cafe/skins/new-cat/skin.json');
    expect(XIANXIAN_SKIN.manifest).toBe('/visible-cafe/skins/xianxian/skin.json');
    expect(SCENES.mainPlanetBg).toBe('/visible-cafe/scenes/main-planet-bg.png');
    for (const url of Object.values(XIANXIAN_SKIN.rows)) {
      expect(url.startsWith('/visible-cafe/skins/xianxian/')).toBe(true);
      expect(url.endsWith('-row.png')).toBe(true);
    }
  });
});
