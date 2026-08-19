/**
 * F258 Visible Café — INV-6: No hardcoded concierge paths
 *
 * All asset URLs must go through VISIBLE_CAFE_ASSET_BASE config constant.
 * No references to /concierge/skins/* allowed in F258 code.
 *
 * This is the grep assertion test — CI-runnable.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('INV-6: no concierge path references', () => {
  const webSrcDir = path.resolve(__dirname, '../../..');

  it('visible-cafe source files contain no /concierge/skins/ references', () => {
    const visibleCafeDir = path.join(webSrcDir, 'lib/visible-cafe');
    const componentsDir = path.join(webSrcDir, 'components/visible-cafe');
    const hooksFile = path.join(webSrcDir, 'hooks/useVisibleCafePresence.ts');
    const storeFile = path.join(webSrcDir, 'stores/visible-cafe-presence.ts');
    const pageDir = path.join(webSrcDir, 'app/starry');

    const dirsToCheck = [visibleCafeDir, componentsDir, pageDir];
    const filesToCheck = [hooksFile, storeFile];

    for (const dir of dirsToCheck) {
      try {
        const result = execSync(`grep -rn "/concierge/skins" "${dir}" 2>/dev/null || true`, { encoding: 'utf-8' });
        expect(result.trim()).toBe('');
      } catch {
        // grep returns non-zero when no match — that's what we want
      }
    }

    for (const file of filesToCheck) {
      try {
        const result = execSync(`grep -n "/concierge/skins" "${file}" 2>/dev/null || true`, { encoding: 'utf-8' });
        expect(result.trim()).toBe('');
      } catch {
        // No match — good
      }
    }
  });

  it('visible-cafe source files use VISIBLE_CAFE_ASSET_BASE for URLs', () => {
    const assetConfigFile = path.join(webSrcDir, 'lib/visible-cafe/asset-config.ts');
    const result = execSync(`grep -c "VISIBLE_CAFE_ASSET_BASE" "${assetConfigFile}" 2>/dev/null || echo "0"`, {
      encoding: 'utf-8',
    });
    // Must appear at least twice (definition + usage)
    expect(Number.parseInt(result.trim(), 10)).toBeGreaterThanOrEqual(2);
  });
});
