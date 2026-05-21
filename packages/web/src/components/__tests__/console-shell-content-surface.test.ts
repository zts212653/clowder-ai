import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const componentsRoot = resolve(testDir, '..');

const surfaceRequirements = ['rounded-2xl', 'border-[var(--console-border-soft)]', 'shadow-[0_12px_30px'];

function readComponent(relativePath: string): string {
  return readFileSync(resolve(componentsRoot, relativePath), 'utf8');
}

describe('console shell content surfaces', () => {
  it.each([
    ['MemoryHub', 'memory/MemoryHub.tsx', 'memory-content-surface'],
    ['SignalInboxView', 'signals/SignalInboxView.tsx', 'signal-inbox-content-surface'],
    ['SignalSourcesView', 'signals/SignalSourcesView.tsx', 'signal-sources-content-surface'],
  ])('%s uses a visible rounded content carrier', (_name, path, testId) => {
    const src = readComponent(path);

    expect(src).toContain(`data-testid="${testId}"`);
    for (const className of surfaceRequirements) {
      expect(src).toContain(className);
    }
  });
});
