// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('root layout build identity', () => {
  it('exposes the independently embedded browser build revision for visible-page admission', () => {
    const source = readFileSync(resolve(appDir, 'layout.tsx'), 'utf8');
    expect(source).toContain('NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION');
    expect(source).toContain('data-cat-cafe-build-revision');
  });

  it('ships the disabled-PWA retirement guard in the fresh document shell', () => {
    const source = readFileSync(resolve(appDir, 'layout.tsx'), 'utf8');
    expect(source).toContain('buildPwaRetirementScript');
    expect(source).toContain('data-cat-cafe-pwa-retirement');
    expect(source).toContain('NEXT_PUBLIC_CAT_CAFE_PWA_ENABLED');
  });
});
