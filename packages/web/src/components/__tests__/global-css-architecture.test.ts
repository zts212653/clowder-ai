// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(testDir, '..', '..', '..');
const appDir = resolve(webRoot, 'src', 'app');

describe('global css architecture', () => {
  it('keeps the base global CSS in the root module graph', () => {
    const layoutSource = readFileSync(resolve(appDir, 'layout.tsx'), 'utf8');

    /* globals.css is the only CSS still loaded via JS import */
    expect(layoutSource).toContain("import './globals.css';");

    // Static stylesheet order and bytes are checked on the actual rendered head
    // in layout-stylesheet-identity.test.tsx.
  });

  it('lets the new-conversation composer overlap its artwork without an opaque host rectangle', () => {
    const shellCss = readFileSync(resolve(appDir, 'shell-v2.css'), 'utf8');
    const landingComposerRule = shellCss.match(
      /\[data-testid="new-conversation-page"\][^{]*div:has\(> \[data-testid="chat-input-composer-row"\]\)\s*\{([^}]*)\}/u,
    );

    expect(landingComposerRule?.[1]).toContain('background: transparent');
  });
});
