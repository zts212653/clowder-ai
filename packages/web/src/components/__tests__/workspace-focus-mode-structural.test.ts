// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(testDir, '..', 'WorkspacePanel.tsx'), 'utf-8');

describe('WorkspacePanel focus entry coverage', () => {
  const PANE_TYPES = ['browser', 'file', 'terminal', 'git', 'changes'] as const;

  for (const pane of PANE_TYPES) {
    it(`has setFocusedPane('${pane}') entry trigger`, () => {
      expect(src).toContain(`setFocusedPane('${pane}')`);
    });
  }
});
