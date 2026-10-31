import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { DEFAULT_INTAKE_CHECKLIST, validateIntakeChecklist } = await import('@cat-cafe/shared');

describe('IntakeChecklist validation', () => {
  test('rejects checklist with no evidence on required items', () => {
    const empty = DEFAULT_INTAKE_CHECKLIST.map((item) => ({ ...item }));
    const result = validateIntakeChecklist(empty);
    assert.equal(result.valid, false);
    assert.equal(result.missing.length, 4);
    assert.ok(result.missing.includes('vision-alignment'));
    assert.ok(result.missing.includes('test-coverage'));
    assert.ok(result.missing.includes('doc-sync'));
    assert.ok(result.missing.includes('no-regression'));
  });

  test('accepts checklist with all required items evidenced', () => {
    const filled = DEFAULT_INTAKE_CHECKLIST.map((item) => ({
      ...item,
      ...(item.required ? { evidence: 'verified by test output', verifiedAt: Date.now(), verifiedBy: 'opus' } : {}),
    }));
    const result = validateIntakeChecklist(filled);
    assert.equal(result.valid, true);
    assert.equal(result.missing.length, 0);
  });

  test('allows optional items without evidence', () => {
    const filled = DEFAULT_INTAKE_CHECKLIST.map((item) => ({
      ...item,
      ...(item.required ? { evidence: 'done' } : {}),
    }));
    const result = validateIntakeChecklist(filled);
    assert.equal(result.valid, true);
  });

  test('partially filled checklist reports only missing required items', () => {
    const partial = DEFAULT_INTAKE_CHECKLIST.map((item) => ({
      ...item,
      ...(item.id === 'vision-alignment' || item.id === 'test-coverage' ? { evidence: 'done' } : {}),
    }));
    const result = validateIntakeChecklist(partial);
    assert.equal(result.valid, false);
    assert.equal(result.missing.length, 2);
    assert.ok(result.missing.includes('doc-sync'));
    assert.ok(result.missing.includes('no-regression'));
  });

  test('DEFAULT_INTAKE_CHECKLIST has 5 items', () => {
    assert.equal(DEFAULT_INTAKE_CHECKLIST.length, 5);
  });
});
