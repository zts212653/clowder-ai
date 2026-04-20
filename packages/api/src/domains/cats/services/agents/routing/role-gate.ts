/**
 * F167 L3 — Role compatibility gate for A2A handoff (MVP).
 *
 * Rule: target cat has `designer` role AND action text contains
 * coding/fix/test/merge keywords → fail-closed rejection.
 *
 * Open-by-default: unknown cats, non-designer targets, and non-coding actions
 * all return `{ allowed: true }`. The gate only denies on an explicit mismatch.
 */

export interface RoleInfo {
  readonly roles: readonly string[];
}

export type RoleLookup = (catId: string) => RoleInfo | undefined;

export interface RoleGateResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly action?: string;
}

const DESIGNER_ROLE = 'designer';

// Bare `test`/`测试` is intentionally NOT a standalone match — review language like
// "check the test results" / "看下测试结果" would false-positive. `test` fires either
// paired with an action verb (write/add/run/build …) OR as bare imperative with an
// explicit object pronoun ("test this/it/…" / "测试这个/它/…"). Critically, the object-
// pronoun branch uses BARE `test` only (not `tests?`): plural `tests` is always a
// noun or 3rd-person verb, never imperative — "this tests my patience" / "the tests
// this week look good" are declarative and must not match (cloud codex F167 PR1 round 2).
const CODING_ACTION_RE =
  /\b(?:code|coding|fix(?:ed|ing|es)?|merge(?:d|s)?|merging|implement(?:ed|ing|s)?)\b|\b(?:write|writing|add|adding|run|running|build|building)\s+(?:unit\s+|e2e\s+|integration\s+)?tests?\b|\btest\s+(?:this|that|these|those|it|them|my|your|the\s+\w+)|写代码|改代码|修(?:bug|代码|复)|(?:写|补|加|跑)\s*测试|测试\s*(?:这|那|它|你|我)|合(?:并|入)/i;

export function checkRoleCompat(targetCatId: string, actionText: string, lookup: RoleLookup): RoleGateResult {
  const info = lookup(targetCatId);
  if (!info) return { allowed: true };
  if (!info.roles.includes(DESIGNER_ROLE)) return { allowed: true };
  if (!actionText) return { allowed: true };

  const match = actionText.match(CODING_ACTION_RE);
  if (!match) return { allowed: true };

  const action = match[0];
  return {
    allowed: false,
    reason: `⛔ @${targetCatId} 不接受 ${action} 任务（角色：designer）`,
    action,
  };
}
