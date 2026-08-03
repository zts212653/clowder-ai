/**
 * F258 Visible Café — Asset Configuration
 *
 * All asset URLs are constructed through VISIBLE_CAFE_ASSET_BASE.
 * AXD-13: F229 atlas will migrate to open-source plugin repo;
 * F258 assets are self-owned copies, migration-immune.
 *
 * 🚫 NO `/concierge/skins/*` references allowed (F229 boundary, 07-09 judgment)
 */

/** Base path for all visible-cafe assets. Single constant for AXD-13 migration immunity. */
export const VISIBLE_CAFE_ASSET_BASE = '/visible-cafe';

/** Build a full asset URL under the visible-cafe base. */
export function visibleCafeAssetUrl(relativePath: string): string {
  return `${VISIBLE_CAFE_ASSET_BASE}/${relativePath}`;
}

/** Skin asset URLs for xianxian. */
export const XIANXIAN_SKIN = {
  manifest: visibleCafeAssetUrl('skins/xianxian/skin.json'),
  rows: {
    idle: visibleCafeAssetUrl('skins/xianxian/idle-row.png'),
    sleeping: visibleCafeAssetUrl('skins/xianxian/sleeping-row.png'),
    working: visibleCafeAssetUrl('skins/xianxian/working-row.png'),
    staged_thought: visibleCafeAssetUrl('skins/xianxian/staged-thought-row.png'),
  },
} as const;

/** Scene background URLs. */
export const SCENES = {
  mainPlanetBg: visibleCafeAssetUrl('scenes/main-planet-bg.png'),
} as const;

/** Skin manifest types (matches skin.json schema). */
export interface SkinRowDef {
  src: string;
  frames: number;
  frameDurations: number[];
  anchorOffsetY: number;
}

export interface SkinManifest {
  id: string;
  displayName: string;
  version: number;
  format: string;
  cell: { width: number; height: number };
  rows: Record<string, SkinRowDef>;
}
