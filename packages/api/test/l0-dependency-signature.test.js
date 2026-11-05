import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { L0DependencySignatureTracker } from '../dist/domains/cats/services/agents/providers/l0-dependency-signature.js';

for (const relativePath of [
  'assets/system-prompts/system-prompt-l0.md',
  'assets/prompt-templates/nested/instructions.md',
  'docs/team/cat-dossier.md',
  'cat-cafe-skills/refs/shared-rules.md',
  'cat-cafe-skills/refs/shared-rules.local.md',
  'cat-cafe-skills/refs/shared-rules.local-override.md',
  '.cat-cafe/prompt-overlays/instructions.md',
]) {
  test(`L0 detects same-size, same-mtime content edits: ${relativePath}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'l0-content-signature-'));
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []');
      const file = join(root, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      const fixedTime = new Date('2026-01-01T00:00:00.000Z');
      const writeContent = (content) => {
        writeFileSync(file, content);
        utimesSync(file, fixedTime, fixedTime);
      };
      writeContent('RULE OLD');
      let invalidations = 0;
      const tracker = new L0DependencySignatureTracker();
      const refresh = () => tracker.refresh(root, join(root, 'scripts/compiler.mjs'), () => invalidations++);
      const initial = refresh();
      assert.equal(refresh(), initial, 'unchanged inputs keep the cached compilation');
      assert.equal(invalidations, 0);

      writeContent('RULE NEW');
      const changed = refresh();
      assert.notEqual(changed, initial, 'content edits cannot be hidden by identical metadata');
      assert.equal(invalidations, 1);
      assert.equal(tracker.isCurrent(initial), false, 'in-flight compilation with old inputs is stale');
      assert.equal(refresh(), changed);
      assert.equal(invalidations, 1, 'stable new contents do not repeatedly invalidate');

      rmSync(file);
      assert.notEqual(refresh(), changed, 'removing a dependency also invalidates');
      assert.equal(invalidations, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
