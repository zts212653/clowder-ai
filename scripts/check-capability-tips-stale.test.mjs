import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkCapabilityTipsStale, detectFeatureStatus } from './check-capability-tips-stale.mjs';

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stale-tips-test-'));
  mkdirSync(path.join(root, 'docs', 'features'), { recursive: true });
  mkdirSync(path.join(root, 'packages', 'web', 'src', 'lib'), { recursive: true });
  mkdirSync(path.join(root, 'cat-cafe-skills', 'refs'), { recursive: true });
  return root;
}

function writeInventory(root, tips) {
  writeFileSync(
    path.join(root, 'packages', 'web', 'src', 'lib', 'capability-tips.seed.json'),
    JSON.stringify(tips, null, 2),
  );
}

function writeFile(root, relativePath, content) {
  const absPath = path.join(root, relativePath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
}

const makeTip = (overrides = {}) => ({
  id: 'test-tip',
  kind: 'capability',
  sourceRef: { path: 'cat-cafe-skills/refs/shared-rules.md', anchor: 'Rules' },
  structureSource: { path: 'cat-cafe-skills/refs/shared-rules.md', anchor: 'Rules' },
  bodySource: { path: 'cat-cafe-skills/refs/shared-rules.md', anchor: 'Rules' },
  contexts: ['thinking'],
  audience: ['cvo'],
  body: '猫猫日常开发遵循 Red-Green-Refactor TDD，先写失败测试再实现。',
  action: { type: 'open_concierge_draft', label: '了解更多' },
  owner: 'opus',
  ...overrides,
});

describe('F244 AC-D4: capability tips stale/sunset check', () => {
  describe('checkCapabilityTipsStale', () => {
    it('passes when all sourceRefs are valid', () => {
      const root = makeRepo();
      writeFile(root, 'cat-cafe-skills/refs/shared-rules.md', '# Rules\n\nSome rules here.\n');
      writeInventory(root, [makeTip()]);

      const report = checkCapabilityTipsStale(root);
      assert.equal(report.ok, true);
      assert.equal(report.findings.length, 0);
    });

    it('detects path_missing when sourceRef file does not exist', () => {
      const root = makeRepo();
      // Create the default structureSource/bodySource file so only sourceRef is missing
      writeFile(root, 'cat-cafe-skills/refs/shared-rules.md', '# Rules\n\nSome rules.\n');
      writeInventory(root, [makeTip({ sourceRef: { path: 'nonexistent.md', anchor: 'X' } })]);

      const report = checkCapabilityTipsStale(root);
      assert.equal(report.ok, false);
      assert.equal(report.findings.length, 1);
      assert.equal(report.findings[0].reason, 'path_missing');
      assert.equal(report.findings[0].tipId, 'test-tip');
      assert.equal(report.findings[0].owner, 'opus');
    });

    it('detects anchor_missing when anchor not in file', () => {
      const root = makeRepo();
      writeFile(root, 'cat-cafe-skills/refs/shared-rules.md', '# Other Content\n');
      writeInventory(root, [makeTip()]);

      const report = checkCapabilityTipsStale(root);
      assert.equal(report.ok, false);
      const anchorFindings = report.findings.filter((f) => f.reason === 'anchor_missing');
      assert.ok(anchorFindings.length > 0, 'should detect at least one anchor_missing');
      assert.equal(anchorFindings[0].anchor, 'Rules');
    });

    it('detects feature_sunset for sunset feature docs', () => {
      const root = makeRepo();
      writeFile(
        root,
        'docs/features/F100-old-feature.md',
        '---\nstatus: sunset\n---\n# F100 Old Feature\n\n## Sunset Anchor\n',
      );
      writeInventory(root, [
        makeTip({
          id: 'sunset-tip',
          sourceRef: { path: 'docs/features/F100-old-feature.md', anchor: 'Sunset Anchor' },
          structureSource: { path: 'docs/features/F100-old-feature.md', anchor: 'Sunset Anchor' },
          bodySource: { path: 'docs/features/F100-old-feature.md', anchor: 'Sunset Anchor' },
          owner: 'codex',
        }),
      ]);

      const report = checkCapabilityTipsStale(root);
      assert.equal(report.ok, false);
      const sunsetFindings = report.findings.filter((f) => f.reason === 'feature_sunset');
      assert.ok(sunsetFindings.length > 0, 'should detect feature_sunset');
      assert.equal(sunsetFindings[0].sunsetStatus, 'sunset');
      assert.equal(sunsetFindings[0].owner, 'codex');
    });

    it('groups findings by owner', () => {
      const root = makeRepo();
      // Create the default file so only explicit sourceRef overrides are missing
      writeFile(root, 'cat-cafe-skills/refs/shared-rules.md', '# Rules\n\nSome rules.\n');
      writeInventory(root, [
        makeTip({ id: 'tip-a', owner: 'opus', sourceRef: { path: 'missing-a.md', anchor: 'X' } }),
        makeTip({ id: 'tip-b', owner: 'codex', sourceRef: { path: 'missing-b.md', anchor: 'Y' } }),
        makeTip({ id: 'tip-c', owner: 'opus', sourceRef: { path: 'missing-c.md', anchor: 'Z' } }),
      ]);

      const report = checkCapabilityTipsStale(root);
      assert.equal(report.ok, false);
      assert.ok(report.byOwner.opus, 'opus findings should exist');
      assert.ok(report.byOwner.codex, 'codex findings should exist');
      assert.equal(report.byOwner.opus.length, 2);
      assert.equal(report.byOwner.codex.length, 1);
    });

    it('deduplicates same tipId + reason + path across fields', () => {
      const root = makeRepo();
      // All three sourceRef fields point to the same missing file
      const sharedRef = { path: 'gone.md', anchor: 'X' };
      writeInventory(root, [
        makeTip({
          sourceRef: sharedRef,
          structureSource: sharedRef,
          bodySource: sharedRef,
        }),
      ]);

      const report = checkCapabilityTipsStale(root);
      // Should only have 1 path_missing finding, not 3
      const pathFindings = report.findings.filter((f) => f.reason === 'path_missing');
      assert.equal(pathFindings.length, 1);
    });

    it('returns summary counts by reason', () => {
      const root = makeRepo();
      // File exists but with wrong anchor content — only 'Wrong Anchor' not 'Rules'
      writeFile(root, 'cat-cafe-skills/refs/shared-rules.md', '# Wrong Anchor\n');
      // tip-missing: sourceRef points to gone.md (path_missing), but structureSource/bodySource
      // also point to shared-rules.md which exists but lacks 'Rules' anchor (anchor_missing).
      // Dedup collapses the 2 anchor_missing findings on shared-rules.md to 1.
      writeInventory(root, [
        makeTip({
          id: 'tip-missing',
          sourceRef: { path: 'gone.md', anchor: 'X' },
          structureSource: { path: 'cat-cafe-skills/refs/shared-rules.md', anchor: 'Wrong Anchor' },
          bodySource: { path: 'cat-cafe-skills/refs/shared-rules.md', anchor: 'Wrong Anchor' },
        }),
        makeTip({
          id: 'tip-anchor',
          sourceRef: { path: 'cat-cafe-skills/refs/shared-rules.md', anchor: 'Rules' },
          structureSource: { path: 'cat-cafe-skills/refs/shared-rules.md', anchor: 'Wrong Anchor' },
          bodySource: { path: 'cat-cafe-skills/refs/shared-rules.md', anchor: 'Wrong Anchor' },
        }),
      ]);

      const report = checkCapabilityTipsStale(root);
      assert.equal(report.summary.path_missing, 1);
      assert.equal(report.summary.anchor_missing, 1);
    });

    it('reports error when inventory file is missing', () => {
      const root = makeRepo();
      // Don't write inventory
      const report = checkCapabilityTipsStale(root);
      assert.equal(report.ok, false);
      assert.ok(report.error);
    });
  });

  describe('detectFeatureStatus', () => {
    it('returns null for non-feature-doc paths', () => {
      const root = makeRepo();
      writeFile(root, 'cat-cafe-skills/refs/shared-rules.md', 'status: sunset\n');
      assert.equal(detectFeatureStatus(root, 'cat-cafe-skills/refs/shared-rules.md'), null);
    });

    it('detects sunset in YAML frontmatter', () => {
      const root = makeRepo();
      writeFile(root, 'docs/features/F100-test.md', '---\nstatus: sunset\n---\n# F100\n');
      assert.equal(detectFeatureStatus(root, 'docs/features/F100-test.md'), 'sunset');
    });

    it('detects closed in inline content', () => {
      const root = makeRepo();
      writeFile(root, 'docs/features/F200-done.md', '# F200\n\nStatus: closed\n');
      assert.equal(detectFeatureStatus(root, 'docs/features/F200-done.md'), 'closed');
    });

    it('returns null for active features', () => {
      const root = makeRepo();
      writeFile(root, 'docs/features/F300-active.md', '---\nstatus: in-progress\n---\n# F300\n');
      assert.equal(detectFeatureStatus(root, 'docs/features/F300-active.md'), null);
    });

    it('returns null when file does not exist', () => {
      const root = makeRepo();
      assert.equal(detectFeatureStatus(root, 'docs/features/F999-ghost.md'), null);
    });

    it('detects done as terminal status', () => {
      const root = makeRepo();
      writeFile(root, 'docs/features/F079-voting-system.md', '---\nstatus: done\n---\n# F079\n');
      assert.equal(detectFeatureStatus(root, 'docs/features/F079-voting-system.md'), 'done');
    });
  });
});
