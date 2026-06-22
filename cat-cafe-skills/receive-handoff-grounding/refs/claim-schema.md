# Claim Schema — `ClaimGroundingEvent` / `WaitSourceRef` / Enums / Invariants

> **PR-O1 scope**: concept-level schema definition. **PR-O2 implements emit + storage**.
> **真相源**: `docs/features/F167-a2a-chain-quality.md` §Phase O R3 Final Convergence.
> **R3.1 增量** (Maine Coon OQ-5/6 final): `WaitSourceRef.slaUntilMs` REQUIRED + `anchorRef` for narrative kinds + `ownershipState` PR-O3 implement.

## Type definitions

### Enums

```typescript
export type ClaimType =
  | 'owner'       // "这是 X 的活" / "这是我的活"
  | 'auth'        // "X 同意 / operator signoff / 守护猫 APPROVE" (拆 AuthSubtype 区分子语义)
  | 'object'      // "PR 在 / issue 已合 / branch 存在"
  | 'wait'        // "等 X 回我"
  | 'route'       // "这是 thread B 的活"
  | 'role'        // "你能做 / 你应该接"
  | 'freshness';  // "这是最新状态"

// claimType='auth' 子语义 (cloud R4 P1#2 修正; INV-O11 引用 'peer_instruction'):
export type AuthSubtype =
  | 'cvo_signoff'        // claim "operator 同意 / landy 签字"
  | 'peer_instruction'   // peer A 让 peer B 不听 PR B owner (需 issuerStanding 核验)
  | 'merge_approval';    // claim "reviewer 已 approve PR"

// issuerStanding (cloud R4 P1#2 修正; INV-O11 require for owner_reassignment / peer_instruction):
export type IssuerStanding =
  | 'cvo'              // landy (T0)
  | 'upstream_owner'   // upstream feature owner (T1: feat_index + git log)
  | 'repo_admin'       // repo admin / org owner (T1: gh api permission)
  | 'pr_reviewer'      // reviewer of target PR (T1: PR review state)
  | 'none';            // 普通 peer → verdict=mismatch (block + push back)

export type SourceKind =
  | 'cross_post'            // a2a cross-thread
  | 'mention'               // 行首 @cat (本 thread)
  | 'reply_in_thread'       // 本 thread reply
  | 'cvo_message'           // landy 本人 message
  | 'webhook'               // GitHub / external webhook
  | 'self';                 // 自己的工具结果

export type ActionFamily =
  | 'read_intent'         // 纯阅读 cross_post / @mention：不强制 grounding (hard trigger 不命中)
  | 'wait'                // hold_ball — A/B rule (球分发 × callback)
  | 'register_tracking'   // register_pr_tracking / register_issue_tracking
  | 'mutate_local'        // 改 worktree files
  | 'merge'               // gh pr merge / squash / close
  | 'cvo_claim'           // claim operator signoff / landy 同意 后续行动
  | 'takeover'            // 接他猫 owner activity
  | 'irreversible'        // delete / force-push / 改圣域 (Redis 6399 等)
  | 'owner_reassignment'; // 改 feat owner / thread kind / PR owner

export type ActionRisk =
  | 'read_only'             // 看文档 / list / search
  | 'mutate_local'          // 改 worktree files
  | 'register_tracking'     // PR/issue tracking task
  | 'hold_ball'             // 占球权
  | 'destructive';          // merge / close / delete / takeover / owner reassignment

export type SourceTier =
  | 'T0'    // hard ground truth: landy direct messageId / git signature / GitHub object/API identity
  | 'T1'    // derived platform truth: PR review/check state / CI
  | 'T2';   // cat-writable / narrative: docs/features / feat_index / thread title / 另一只猫 claim

// Claim-level verdict 终态 (three-state; final state on claim grounding event):
export type Verdict =
  | 'verified'              // resolver 返回与 claim 一致 (high-risk 需 T0/T1 evidence)
  | 'mismatch'              // resolver 返回与 claim 冲突
  | 'insufficient';         // resolver 无法返回足够证据 (含 budget exhausted, T2-only on high-risk,
                            //   所有 applicable resolver 都返回 not_applicable)

// Per-resolver outcome (NOT a claim-level verdict; 'not_applicable' triggers next-resolver attempt):
export type ResolverOutcome =
  | Verdict                 // resolver successfully classified the claim
  | 'not_applicable';       // 该 resolver 不适用此 claimType；状态机回 resolving 尝试下一个 applicable resolver
```

### Core event

```typescript
export interface ClaimGroundingEvent {
  // 身份
  invocationId: string;
  catId: string;
  threadId: string;
  sourceThreadId?: string;       // cross-thread 时

  // claim (Q1)
  claimType: ClaimType;
  authSubtype?: AuthSubtype;     // cloud R4 P1#2 — REQUIRED when claimType='auth'; 区分 cvo_signoff/peer_instruction/merge_approval
  sourceKind: SourceKind;
  sourceRef: SourceRef;          // messageId / PR URL+headSha / issue id / etc.
  claimSummary?: string;          // 短摘要 (≤200 字 + content hash); not raw body

  // resolver (Q2)
  resolver: string;               // resolver id (e.g. 'feat_index.lookup')
  resolverArgs?: Record<string, string>;  // 短键值 (id / status / count); not raw payload
  resolverSourceTier: SourceTier;         // R3 新增 — 每个 resolver result 必填
  freshnessKey?: string;          // R3 新增 — SHA / messageId / PR head / check identity 等不可变身份；undefined = TTL-based resolver
  cacheHit: boolean;

  // verdict (Q3)
  verdict: Verdict;
  verdictReason?: string;         // e.g. 'resolver_budget_exhausted' / 'T2_only_on_high_risk' / 'issuer_standing_missing'

  // 后果
  actionFamily: ActionFamily;     // R3 新增 — Hard trigger 主轴；不是 keyword
  actionRisk: ActionRisk;
  tool: string;                   // 触发此 grounding 的工具
  threadKind?: 'concierge' | 'gate-keeping' | null;  // context signal only, not truth source

  // OQ-5 specific (when actionFamily='wait')
  waitSourceRef?: WaitSourceRef;  // REQUIRED for hold_ball; null for other waits

  // OQ-6 specific (when actionFamily='register_tracking')
  ownershipState?: OwnershipState;  // PR-O3 implement; PR-O1 document only

  // R4 cloud P1#2 specific (when actionFamily='owner_reassignment' OR authSubtype='peer_instruction')
  issuerStanding?: IssuerStanding;  // INV-O11 REQUIRED in those cases; missing → soft-block

  // soft hint (R3 OQ-4)
  keywordHintMatched?: string[];  // soft trigger 命中关键词列表; not enforcement, telemetry only

  // observability
  ts: number;
  resolverCallsRemaining: number;
}

export interface SourceRef {
  kind: 'messageId' | 'pr_url' | 'issue_id' | 'feature_path' | 'task_id' | 'webhook_id' | 'commit_sha';
  value: string;
  status?: string;                // 'open' / 'merged' / 'closed' / etc.
  headSha?: string;
}
```

### WaitSourceRef (R3.1 Maine Coon OQ-5 final)

```typescript
export type WaitSourceRef = {
  kind: 'github_issue' | 'github_comment' | 'thread_message' | 'task' | 'reporter_handle' | 'pending_input';
  value: string;             // 主对象标识 (issue id / comment id / thread message id / task id / handle / input ref)
  anchorRef?: string;        // REQUIRED when kind ∈ {'reporter_handle', 'pending_input'}
                             // narrative kinds 必须锚到 durable id (GitHub issue/comment id 或 thread messageId/task id)
  expectedSignal: string;    // 等什么信号醒 (e.g. 'comment_from_reporter', 'review_state_change', 'cvo_message')
  slaUntilMs: number;        // REQUIRED — 不是 optional; 无 SLA = no hold, route to needs-info/sweep
};
```

**Schema constraints**：

- `slaUntilMs` REQUIRED；缺 → `hold_ball` fail-closed，路由 daily sweep
- `slaUntilMs - now <= 3_600_000` — mirror `wakeAfterMs <= 1h`；不允许 multi-hold extension
- `kind ∈ {'reporter_handle', 'pending_input'}` → `anchorRef` REQUIRED（narrative 太 forgeable，必须锚到 durable object id）

### OwnershipState (R3.1 Maine Coon OQ-6, PR-O3 implement)

```typescript
export type OwnershipState =
  | 'keeper_owned'    // 本 keeper thread 仍持 intake，无 downstream owner
  | 'distributed'     // 球已通过 cross_post / propose_thread / task / PR routing 分发到 downstream
  | 'unknown';        // 无法 conclusively 证明（resolver budget 耗尽 / 没 routing trail）
```

**Verdict 规则** (PR-O3 implement)：

| ownershipState | + 证据 | → action |
|---------------|--------|---------|
| `keeper_owned` | + explicit intake `sourceRef` | allow `register_issue_tracking` |
| `distributed` | — | **block**（由 downstream owner 处理）|
| `unknown` | — | **insufficient**（soft-block + 退回 source 澄清）|

> **PR-O1 only document**：`existingTask?.ownerCatId` 必要但不充分；PR-O1 把它作为 resolver
> 的一个 input，不当 final verdict。完整 `ownershipState` resolver 在 PR-O3 实施。

## Constraints / Invariants (INV-O1..O11)

PR-O1 doc-only enforcement；PR-O2 实施时作为 runtime schema 约束。

### State machine (claim grounding lifecycle)

| State \\ Event | `claim_received` | `resolver_invoked` | `resolver_returned` | `budget_exhausted` | `action_taken` |
|---|---|---|---|---|---|
| `(none)` | → `proposed` | ❌ | ❌ | ❌ | ❌ |
| `proposed` | ❌ | → `resolving` | ❌ | → `insufficient`(终态) | ❌ |
| `resolving` | ❌ | → `resolving`(loop, budget--) | → `verified` / `mismatch` / `insufficient`；`not_applicable` → `resolving`（换下一个 applicable resolver；若已无 applicable resolver → `insufficient`(终态)，reason=`no_applicable_resolver`）| → `insufficient`(终态) | ❌ |
| `verified` | ❌ | ❌ | ❌ | ❌ | → `done`(终态) |
| `mismatch` | ❌ | ❌ | ❌ | ❌ | → `blocked`/`pushed_back`(终态) |
| `insufficient` | ❌ | ❌ | ❌ | ❌ | → `proceeded_with_warn`/`blocked` |

### Invariants

- **INV-O1**: 任何 `claim_received` 必须有 `sourceRef`（kind + value 非空）+ `claimType` ∈ 7 类枚举
- **INV-O2**: claim 级 `verdict` 终态 ∈ `{verified, mismatch, insufficient}`（**three-state**）；不留 dangling intermediate。`not_applicable` 是 **per-resolver `ResolverOutcome`**（中间信号，非 claim 终态）；见 INV-O8
- **INV-O3** (R3 updated): `resolver_invoked` 必须带 `resolverSourceTier`；high-risk `actionFamily`
  (`merge / cvo_claim / takeover / irreversible / owner_reassignment`) 的 `verified` verdict
  **必须 ≥1 个 T0/T1 resolver result**；T2-only → 强制降为 `insufficient`
- **INV-O4**: `action_taken` 必在终态后；`destructive` actionRisk + `mismatch` verdict → 必转 `blocked`
- **INV-O5**: counter 100% 计数 ≥ sample event 计数；sample 受 PR-O2 sampling 规则约束
  （`mismatch` / `blocked` 100% / `insufficient` 3-per-resolver-thread-day / `verified` 1/20）
- **INV-O6**: `claimType='auth'` 时 `sourceRef.kind='messageId'` resolver 的 message author
  必须 = `'you'`（catId 严格匹配；不接受 `'you'` / `'you'` handle variant）才能 satisfy auth claim
- **INV-O7** (R3 updated): `cacheHit=true` 不消耗 budget；**但** `freshnessKey` 存在时
  cache lookup 必须 verify key match，key mismatch → cache miss + 消耗 budget
- **INV-O8**: `not_applicable` 是 **per-resolver `ResolverOutcome`**（非 claim 级终态 verdict）；
  resolver returns `not_applicable` → 状态机回 `resolving`，尝试下一个 applicable resolver；
  当所有 applicable resolver 都返回 `not_applicable` → claim 终态降为 `insufficient`
  (reason=`no_applicable_resolver`)。不计入 `mismatch` 累积；不出现在 `ClaimGroundingEvent.verdict` 字段
- **INV-O9**: 跨 invocation 状态不复用（每次 invocation 重置 budget；不做 long-running grounding session）
- **INV-O10** (R3 new): `actionFamily='read_intent'` 不进入 grounding 状态机（skill 不 trigger）；
  soft keyword hint 只记 `keywordHintMatched` 不创建 `ClaimGroundingEvent`
- **INV-O11** (R3 new; cloud R4 P1#2 修正 — 字段命名规范化):
  `issuerStanding` 字段在 `actionFamily='owner_reassignment'` 或
  `(claimType='auth' AND authSubtype='peer_instruction')` 时**必须存在**且 verdict 已 evaluated；
  缺失 → soft-block。`IssuerStanding='none'` (普通 peer) → claim verdict=`mismatch` (block + push back)
- **INV-O12** (cloud R3+R4 lessons; 状态契约固化 per LL-072 ≥3 轮同类 finding):
  `feat_index` resolver `sourceTier` **不变量**——任何 `feat_index.*` 单独调用 → **T2** (cat-writable;
  与 `docs/features/*` / thread title / 另一只猫 claim 同级 narrative)；高危 actionFamily
  (`merge / cvo_claim / takeover / irreversible / owner_reassignment`) 的 `verified` 必须有 ≥1 个
  T0/T1 独立 resolver (gh api object / git log signature / `landy` messageId)，**T2-only feat_index
  hit 强制降为 `insufficient`** (per INV-O3)。**唯一例外**：`feat_index` 与 `git log signature`
  联合证据组成 `upstream_owner` standing 时 sourceTier=T1（composed evidence，不是 feat_index alone）

### Adversarial scenarios (mitigation)

1. **Resolver 返回过期数据**（freshness=stale）→ 升级到 `freshness` claim 查 HEAD vs origin/main；
   单 resolver 查 PR state 不够（INV-O3 + freshnessKey）
2. **Resolver 自身被传球者控制**（如查"传球者 thread context"）→ schema 拒绝（INV-O6 类规则）
3. **Claim 链式假证**（"X 说 Y 说 Z 同意"）→ skill 三问展开每层 claim 独立 verify；不接受 transitively
4. **Budget exhausted on destructive action** → INV-O3 强制 `insufficient`；destructive + `insufficient`
   = block，无 fallback
5. **Multiple claims, partial verified**（接球 message 有 N 个 claim，部分 verified 部分 mismatch）
   → 任一 mismatch + destructive risk = 全部 block；非 destructive = warn + proceed for verified subset
