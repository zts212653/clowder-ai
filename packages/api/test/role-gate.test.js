import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { checkRoleCompat } = await import('../dist/domains/cats/services/agents/routing/role-gate.js');

function makeLookup(map) {
  return (catId) => {
    const roles = map[catId];
    return roles ? { roles } : undefined;
  };
}

describe('F167 L3: role-gate checkRoleCompat', () => {
  test('designer + "fix bug" → rejected with reason naming target and role', () => {
    const lookup = makeLookup({ gemini: ['designer'] });
    const result = checkRoleCompat('gemini', 'fix bug', lookup);
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason, 'rejection must include a reason');
    assert.match(result.reason, /@gemini/, 'reason must name the target cat');
    assert.match(result.reason, /designer/, 'reason must mention the incompatible role');
    assert.strictEqual(result.action?.toLowerCase(), 'fix');
  });

  test('designer + 中文 "写代码" → rejected', () => {
    const lookup = makeLookup({ gemini: ['designer'] });
    const result = checkRoleCompat('gemini', '你来写代码吧', lookup);
    assert.strictEqual(result.allowed, false);
  });

  test('designer + explicit coding-test compositions → rejected', () => {
    const lookup = makeLookup({ gemini: ['designer'] });
    assert.strictEqual(checkRoleCompat('gemini', 'run tests', lookup).allowed, false);
    assert.strictEqual(checkRoleCompat('gemini', 'write tests for this', lookup).allowed, false);
    assert.strictEqual(checkRoleCompat('gemini', '补测试', lookup).allowed, false);
    assert.strictEqual(checkRoleCompat('gemini', 'merge PR', lookup).allowed, false);
    assert.strictEqual(checkRoleCompat('gemini', 'coding task', lookup).allowed, false);
  });

  test('designer + review language with bare "test" → allowed (no false positive on review)', () => {
    // Codex P2: bare test/tests must not match review-language like "check the test results".
    const lookup = makeLookup({ gemini: ['designer'] });
    assert.strictEqual(
      checkRoleCompat('gemini', 'check the test results', lookup).allowed,
      true,
      '"check the test results" is review language, must not trigger rejection',
    );
    assert.strictEqual(
      checkRoleCompat('gemini', 'test report looks good', lookup).allowed,
      true,
      '"test report" is a noun phrase, not a coding verb',
    );
    assert.strictEqual(
      checkRoleCompat('gemini', '看下测试结果', lookup).allowed,
      true,
      '"看下测试结果" is review language',
    );
  });

  test('designer + imperative "test X" → rejected (cloud P2: do not let imperative test slip through)', () => {
    // Cloud codex review P2: by removing bare test matching we over-relaxed — imperative
    // "test this fix" / "测试这个 bug" must still be blocked for designer role (AC-A7 protection).
    const lookup = makeLookup({ gemini: ['designer'] });
    assert.strictEqual(
      checkRoleCompat('gemini', 'test this fix', lookup).allowed,
      false,
      '"test this fix" is imperative testing assignment',
    );
    assert.strictEqual(
      checkRoleCompat('gemini', 'test the new bug', lookup).allowed,
      false,
      '"test the new bug" is imperative with explicit object',
    );
    assert.strictEqual(
      checkRoleCompat('gemini', '测试这个 bug', lookup).allowed,
      false,
      '"测试这个 bug" is imperative in Chinese',
    );
    assert.strictEqual(checkRoleCompat('gemini', '测试它', lookup).allowed, false, '"测试它" is imperative (test it)');
  });

  test('designer + declarative plural "tests" → allowed (cloud P1 round 2)', () => {
    // Cloud codex review P1 (round 2): my imperative "test X" matcher was too loose.
    // `\btests?\s+(this|that|my|your|...)` also matched declarative plural "tests":
    //   - "this tests my patience" — idiom, declarative
    //   - "the tests this week look good" — plural noun + temporal phrase
    // Fix: restrict to bare `test` (imperative base form only; "tests" is plural/3rd-person, not imperative).
    const lookup = makeLookup({ gemini: ['designer'] });
    assert.strictEqual(
      checkRoleCompat('gemini', 'this tests my patience', lookup).allowed,
      true,
      '"this tests my patience" is declarative idiom, not an assignment',
    );
    assert.strictEqual(
      checkRoleCompat('gemini', 'the tests this week look good', lookup).allowed,
      true,
      '"the tests this week look good" is declarative (plural noun + temporal phrase)',
    );
    assert.strictEqual(
      checkRoleCompat('gemini', 'tests my knowledge', lookup).allowed,
      true,
      '"tests my knowledge" is 3rd-person declarative, not imperative',
    );
  });

  test('designer + non-coding action (review / 看一下) → allowed', () => {
    const lookup = makeLookup({ gemini: ['designer'] });
    assert.strictEqual(checkRoleCompat('gemini', 'review 一下方案', lookup).allowed, true, 'designer can review');
    assert.strictEqual(
      checkRoleCompat('gemini', '看一下这个设计', lookup).allowed,
      true,
      'designer can review (chinese)',
    );
  });

  test('coder + coding action → allowed', () => {
    const lookup = makeLookup({ spark: ['coder'] });
    assert.strictEqual(checkRoleCompat('spark', 'fix bug', lookup).allowed, true);
  });

  test('architect + coding → allowed (MVP scope: only designer blocked)', () => {
    const lookup = makeLookup({ opus: ['architect', 'peer-reviewer'] });
    assert.strictEqual(checkRoleCompat('opus', 'write code', lookup).allowed, true);
  });

  test('unknown cat → allowed (role-gate is not a registry check)', () => {
    const lookup = makeLookup({});
    assert.strictEqual(checkRoleCompat('ghost', 'fix bug', lookup).allowed, true);
  });

  test('multi-role cat with designer in list → still rejected on coding (designer dominant)', () => {
    const lookup = makeLookup({ gemini25: ['designer', 'visual'] });
    assert.strictEqual(checkRoleCompat('gemini25', 'fix this bug', lookup).allowed, false);
  });

  test('empty action text → allowed', () => {
    const lookup = makeLookup({ gemini: ['designer'] });
    assert.strictEqual(checkRoleCompat('gemini', '', lookup).allowed, true);
  });

  test('action keyword inside larger word should NOT match (word boundary)', () => {
    const lookup = makeLookup({ gemini: ['designer'] });
    assert.strictEqual(
      checkRoleCompat('gemini', 'codebase walkthrough', lookup).allowed,
      true,
      '"codebase" is not a coding action',
    );
    assert.strictEqual(checkRoleCompat('gemini', 'merger document', lookup).allowed, true, '"merger" is not "merge"');
  });
});
