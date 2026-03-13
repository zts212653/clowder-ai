import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('F086 M2: Meta-thinking trigger documentation', () => {
  const sharedRules = readFileSync(resolve(__dirname, '../../../cat-cafe-skills/refs/shared-rules.md'), 'utf-8');

  it('shared-rules contains §13 meta-thinking trigger section', () => {
    assert.ok(sharedRules.includes('§13'), 'Missing §13 section');
    assert.ok(sharedRules.includes('元思考触发器'), 'Missing trigger section title');
  });

  it('documents all 5 trigger types (A-E)', () => {
    const triggers = ['A: 高影响决策', 'B: 跨领域问题', 'C: 高不确定性', 'D: 信息不足', 'E: 新领域侦查'];
    for (const t of triggers) {
      assert.ok(sharedRules.includes(t), `Missing trigger: ${t}`);
    }
  });

  it('documents hardcheck vs soft guidance distinction', () => {
    assert.ok(sharedRules.includes('searchEvidenceRefs'), 'Missing searchEvidenceRefs reference');
    assert.ok(sharedRules.includes('overrideReason'), 'Missing overrideReason reference');
  });

  it('triggerType enum values match documented triggers', () => {
    // Read source directly (no build required) and regex-match the enum
    const callbackToolsSrc = readFileSync(resolve(__dirname, '../../mcp-server/src/tools/callback-tools.ts'), 'utf-8');
    const enumMatch = callbackToolsSrc.match(/triggerType:\s*z[\s\S]*?\.enum\(\[([^\]]+)\]\)/);
    assert.ok(enumMatch, 'Could not find triggerType z.enum in callback-tools.ts');
    const rawValues = enumMatch[1]
      .replace(/'/g, '')
      .split(',')
      .map((s) => s.trim());
    const expected = ['high-impact', 'cross-domain', 'uncertain', 'info-gap', 'recon'];
    assert.deepStrictEqual([...rawValues].sort(), [...expected].sort());
  });

  it('feat-lifecycle contains Design Gate 先搜现状 check', () => {
    const featLifecycle = readFileSync(resolve(__dirname, '../../../cat-cafe-skills/feat-lifecycle/SKILL.md'), 'utf-8');
    assert.ok(featLifecycle.includes('先搜现状'), 'Missing Design Gate pre-check');
    assert.ok(featLifecycle.includes('新领域侦查'), 'Missing trigger E reference');
  });

  it('collaborative-thinking references trigger rules', () => {
    const collabThinking = readFileSync(
      resolve(__dirname, '../../../cat-cafe-skills/collaborative-thinking/SKILL.md'),
      'utf-8',
    );
    assert.ok(collabThinking.includes('§13'), 'Missing §13 reference');
  });
});
