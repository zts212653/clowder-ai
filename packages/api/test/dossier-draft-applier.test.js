/**
 * F208 AC-E3: DossierDraftApplier unit tests
 *
 * Tests the pure prepareDraft() function — no I/O, no git, no Redis.
 * Verifies: baseHash stale-write lock, beforeSnapshot replacement,
 * status gate, commit message formatting.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, describe, it } from 'node:test';

/** Compute SHA-256 hash (same as the service). */
function hash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Minimal proposal factory. */
function makeProposal(overrides = {}) {
  const fileContent = overrides._fileContent ?? SAMPLE_DOSSIER;
  return {
    proposalId: 'prop-001',
    status: 'approved',
    sourceEvent: 'feat-phase-close',
    sourceId: 'feat-phase-close:F208:E',
    targetCatId: 'opus',
    targetFields: ['nativePeakAbilities'],
    beforeSnapshot:
      '快速编码 + 系统设计一体。能在一个 session 内从 spec 到实现到测试全链路推完。代码速度是布偶猫家族最快的。天然理解文件系统路径和结构。',
    afterDraft:
      '快速编码 + 系统设计一体。能在一个 session 内从 spec 到实现到测试全链路推完。代码速度是布偶猫家族最快的。天然理解文件系统路径和结构。**[v0.2 | 2026-06-21]** 事件驱动蒸馏管线设计 + 实现：从 spec 到 4 测试到跨族 review 闭环仅 1 session。',
    rationale: 'Phase E AC-E2 实现展示了 spec→impl→test 全链路能力',
    evidenceRefs: [{ type: 'review', id: 'PR#2467', summary: 'AC-E2 implementation' }],
    baseHash: hash(fileContent),
    createdBy: 'system',
    createdAt: Date.now(),
    approvedBy: 'you',
    approvedAt: Date.now(),
    ...overrides,
  };
}

const SAMPLE_DOSSIER = `---
feature_id: F208
---

# Clowder AI 能力画像档案 (Cat Dossier)

## 四主力猫 L1 画像

### 布偶猫 Opus 4.6 · @opus · \`cat:opus\`

| # | 字段 | 内容 |
|---|------|------|
| ① | **原生峰值** | 快速编码 + 系统设计一体。能在一个 session 内从 spec 到实现到测试全链路推完。代码速度是布偶猫家族最快的。天然理解文件系统路径和结构。 |
| ② | **被低估能力** | 听得懂人话 |

### 布偶猫 Opus 4.7 · @opus47 · \`cat:opus-47\`

| # | 字段 | 内容 |
|---|------|------|
| ① | **原生峰值** | 深度思辨 |
`;

describe('DossierDraftApplier', () => {
  /** @type {typeof import('../dist/domains/cats/services/distillation/DossierDraftApplier.js')} */
  let mod;

  // Dynamic import from dist — requires build
  before(async () => {
    mod = await import('../dist/domains/cats/services/distillation/DossierDraftApplier.js');
  });

  describe('prepareDraft()', () => {
    it('returns modified content on happy path (baseHash matches, beforeSnapshot found)', () => {
      const proposal = makeProposal();
      const result = mod.prepareDraft(proposal, SAMPLE_DOSSIER);

      assert.equal(result.ok, true);
      // afterDraft is present (it extends beforeSnapshot with a version tag)
      assert.ok(result.result.modifiedContent.includes('[v0.2 | 2026-06-21]'));
      assert.ok(result.result.modifiedContent.includes(proposal.afterDraft));
      // File actually changed (not identical to original)
      assert.notEqual(result.result.modifiedContent, SAMPLE_DOSSIER);
      assert.equal(result.result.targetPath, 'docs/team/cat-dossier.md');
    });

    it('commit message includes proposal metadata', () => {
      const proposal = makeProposal();
      const result = mod.prepareDraft(proposal, SAMPLE_DOSSIER);

      assert.equal(result.ok, true);
      assert.ok(result.result.commitMessage.includes('F208'));
      assert.ok(result.result.commitMessage.includes('opus'));
      assert.ok(result.result.commitMessage.includes('prop-001'));
      assert.ok(result.result.commitMessage.includes('you'));
    });

    it('rejects with BASE_HASH_MISMATCH when file has changed since proposal', () => {
      const proposal = makeProposal();
      const modifiedFile = SAMPLE_DOSSIER + '\n<!-- someone edited this -->';
      const result = mod.prepareDraft(proposal, modifiedFile);

      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'BASE_HASH_MISMATCH');
      assert.ok(result.error.currentHash);
      assert.notEqual(result.error.currentHash, proposal.baseHash);
    });

    it('rejects with NOT_APPROVED when proposal status is not approved', () => {
      const proposal = makeProposal({ status: 'pending' });
      const result = mod.prepareDraft(proposal, SAMPLE_DOSSIER);

      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'NOT_APPROVED');
    });

    it('rejects with BEFORE_SNAPSHOT_NOT_FOUND when snapshot is malformed', () => {
      // Force baseHash to match but beforeSnapshot doesn't exist in file
      const proposal = makeProposal({
        beforeSnapshot: 'THIS TEXT DOES NOT EXIST IN THE FILE',
        baseHash: hash(SAMPLE_DOSSIER),
      });
      const result = mod.prepareDraft(proposal, SAMPLE_DOSSIER);

      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'BEFORE_SNAPSHOT_NOT_FOUND');
    });

    it('P1-new-1: fails closed when target cat section header is missing (no whole-file fallback)', () => {
      // Regression: if targetCatId has no matching `cat:{id}` header in the dossier,
      // the function must error out rather than falling back to whole-file search
      // (which could corrupt another cat's section).
      const proposal = makeProposal({
        targetCatId: 'nonexistent-cat',
        baseHash: hash(SAMPLE_DOSSIER), // force baseHash to match
      });
      const result = mod.prepareDraft(proposal, SAMPLE_DOSSIER);

      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'BEFORE_SNAPSHOT_NOT_FOUND');
      assert.ok(
        result.error.message.includes('section header'),
        'Error message must indicate section header not found (not generic snapshot miss)',
      );
    });

    it('preserves other cat sections when applying draft', () => {
      const proposal = makeProposal();
      const result = mod.prepareDraft(proposal, SAMPLE_DOSSIER);

      assert.equal(result.ok, true);
      // Opus 4.7 section must remain intact
      assert.ok(result.result.modifiedContent.includes('布偶猫 Opus 4.7'));
      assert.ok(result.result.modifiedContent.includes('深度思辨'));
    });

    it('replaces only within the target cat section, not in other sections with same text', () => {
      // P1-1 regression: if beforeSnapshot text appears in another cat's section
      // (earlier in the file), unanchored .replace() corrupts the wrong cat.
      const SHARED_TEXT =
        '快速编码 + 系统设计一体。能在一个 session 内从 spec 到实现到测试全链路推完。代码速度是布偶猫家族最快的。天然理解文件系统路径和结构。';
      const DOSSIER_WITH_COLLISION = `---
feature_id: F208
---

# Clowder AI 能力画像档案 (Cat Dossier)

## 四主力猫 L1 画像

### 布偶猫 Opus 4.7 · @opus47 · \`cat:opus-47\`

| # | 字段 | 内容 |
|---|------|------|
| ① | **原生峰值** | ${SHARED_TEXT} |
| ② | **被低估能力** | 深度思辨 |

### 布偶猫 Opus 4.6 · @opus · \`cat:opus\`

| # | 字段 | 内容 |
|---|------|------|
| ① | **原生峰值** | ${SHARED_TEXT} |
| ② | **被低估能力** | 听得懂人话 |
`;
      const proposal = makeProposal({
        targetCatId: 'opus',
        beforeSnapshot: SHARED_TEXT,
        afterDraft: SHARED_TEXT + ' **[v0.2]** 事件驱动蒸馏管线设计',
        baseHash: hash(DOSSIER_WITH_COLLISION),
        _fileContent: DOSSIER_WITH_COLLISION,
      });
      const result = mod.prepareDraft(proposal, DOSSIER_WITH_COLLISION);

      assert.equal(result.ok, true);
      // The target cat's (opus) section must have the afterDraft
      assert.ok(result.result.modifiedContent.includes(proposal.afterDraft));
      // The OTHER cat's (opus-47) section must still have the ORIGINAL text unchanged
      // Find opus-47 section and verify it wasn't touched
      const opus47Section = result.result.modifiedContent.split('`cat:opus-47`')[1].split('`cat:opus`')[0];
      assert.ok(opus47Section.includes(SHARED_TEXT), 'opus-47 section must retain original text');
      assert.ok(!opus47Section.includes('[v0.2]'), 'opus-47 section must NOT have the afterDraft');
    });

    it('cloud-P1-a: rejects when beforeSnapshot only exists in a LATER section (section-bounded search)', () => {
      // Regression: if searchScope goes to EOF, text in a later section matches.
      // With section-bounded search, text only in a LATER section must NOT match.
      const LATER_ONLY_TEXT = '独有文本只在后面的section';
      const DOSSIER_LATER_MATCH = `---
feature_id: F208
---

# Clowder AI 能力画像档案 (Cat Dossier)

### 布偶猫 Opus 4.6 · @opus · \`cat:opus\`

| # | 字段 | 内容 |
|---|------|------|
| ① | **原生峰值** | 快速编码 |

### 布偶猫 Opus 4.7 · @opus47 · \`cat:opus-47\`

| # | 字段 | 内容 |
|---|------|------|
| ① | **原生峰值** | ${LATER_ONLY_TEXT} |
`;
      const proposal = makeProposal({
        targetCatId: 'opus', // target is FIRST section
        beforeSnapshot: LATER_ONLY_TEXT, // but text is in SECOND section only
        afterDraft: LATER_ONLY_TEXT + ' MODIFIED',
        baseHash: hash(DOSSIER_LATER_MATCH),
        _fileContent: DOSSIER_LATER_MATCH,
      });
      const result = mod.prepareDraft(proposal, DOSSIER_LATER_MATCH);

      // Must REJECT — text is not in target section, only in later section
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'BEFORE_SNAPSHOT_NOT_FOUND');
    });
  });

  describe('computeFileHash()', () => {
    it('produces consistent SHA-256 hex hashes', () => {
      const h = mod.computeFileHash('hello world');
      assert.equal(h, hash('hello world'));
      assert.equal(h.length, 64); // SHA-256 = 32 bytes = 64 hex chars
    });
  });
});
