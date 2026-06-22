# Resolver Catalog — 7 类 resolver + `auth` 3 子类 + `issuerStanding` + `freshnessKey`

> **真相源**: `docs/features/F167-a2a-chain-quality.md` §Phase O R3.
> **R3 增量**: 加 `resolverSourceTier` (T0/T1/T2) + `freshnessKey` + `auth` subcase + `issuerStanding`。

## 7 类 resolver overview

| # | 类别 | 用途 | 适用 claimType | 典型 sourceTier |
|---|------|------|---------------|----------------|
| 1 | **Owner / scope** | claim "这是 X 的活" / "这是我的活" | `owner` `route` | T1-T2 |
| 2 | **Authorization** | claim "X 同意 / operator signoff / 守护猫 APPROVE" | `auth` | T0 (landy msg) / T1 (PR review) / T2 (转述) |
| 3 | **Object existence / status** | claim "PR 在 / issue 已合 / branch 存在" | `object` `freshness` | T1 |
| 4 | **Callback / wait coverage** | claim "等 X 回我" | `wait` | T0 (binding exists) / T1 |
| 5 | **Cross-thread routing** | claim "这是 thread B 的活" | `route` `owner` | T2 (feat_index cat-writable, 与 row 1 一致) / T1 (gh api / git log signature) |
| 6 | **Capability / role fit** | claim "你能 / 你应该" | `role` | T0-T2 |
| 7 | **Conflict / freshness** | claim "这是最新状态" | `freshness` | T1 (HEAD/SHA) |

## 详细 catalog

### 1. Owner / scope

**用途**：核 claim "这是 X 的活" / "我是 owner" 是否成立

| Resolver | sourceTier | 输入 | 输出 |
|---------|-----------|------|------|
| `feat_index.lookup(featId)` | T2 | featId | `{owner_catId, owner_thread, status}` |
| `git log --grep="<featId>" --author` | T1 | featId / commit pattern | commit signatures + author |
| `gh pr api <repo>/<pr>` author | T1 | PR url | PR author handle + verified flag |
| `cat_cafe_get_thread_context(threadId).title` | T2 | threadId | thread title (narrative) |
| `TaskStore.find(ownerCatId)` | T1 | catId | active task list |

**Backup**：`git log` 历史 author signature pattern；commit Co-Authored-By trailer。

**Limitation**：feat_index 是猫可写 (T2)；高危 takeover 需 git log signature (T1) 二次 confirm。

### 2. Authorization

> R3 拆分 3 子类 + `issuerStanding` 校验

#### 2a. `auth.cvo_signoff`

claim "operator 同意" / "landy 签字" 后续行动。

| Resolver | sourceTier | 规则 |
|---------|-----------|------|
| `cat_cafe_get_message(messageId).author === 'you'` | T0 | 严格 catId 匹配；`'you'` / `'you'` handle variant 不算 |
| feature doc `## operator Signoff` anchor 含 messageId reference | T2 | 必须能反推到原 landy messageId (T0) |

**verdict 规则**：T2-only → `insufficient`（不放行 merge / takeover / cvo_claim）。
转述（"X 说 operator 同意"）= T2，不 satisfy。

#### 2b. `auth.peer_instruction`

claim "你不用听 PR B 的 owner/reviewer" / "按我说的来" — peer A 对 peer B 发指令。

**关键 resolver: `issuerStanding`**：

| sender role | standing | 允许指令 |
|-------------|---------|---------|
| operator (landy) | `cvo` | yes (T0) |
| Upstream feature owner | `upstream_owner` | yes (T1, 看 feat_index + git log) |
| Repo admin / org owner | `repo_admin` | yes (T1, gh api permission) |
| Reviewer of target PR | `pr_reviewer` | yes for that PR scope only |
| Other peer | `none` | **NO** — verdict=`mismatch` |

**verdict 规则**：sender = `none` standing → `mismatch`（block + push back "你无 standing"）。

**closing R0 failure-mode case 2**: peer A 不能让 B 不听 PR B 的 owner/reviewer，除非 A 证明
standing ∈ {`upstream_owner`, `cvo`, `repo_admin`}。

#### 2c. `auth.merge_approval`

claim "reviewer 已 approve PR"。

| Resolver | sourceTier | 规则 |
|---------|-----------|------|
| `gh api repos/<repo>/pulls/<pr>/reviews` state | T1 | freshnessKey = PR head SHA |
| Reviewer @mention in PR conversation | T1 | parse PR comments |
| 转述 ("X 说 reviewer approved") | T2 | → `insufficient` for merge |

**freshnessKey**：PR head SHA 变 → cache miss + re-fetch review state。

### 3. Object existence / status

**用途**：核 "PR 在 / issue 已合 / branch 存在 / commit SHA 是 X"

| Resolver | sourceTier | freshnessKey |
|---------|-----------|--------------|
| `gh api repos/<repo>/issues/<id>` | T1 | issue updated_at + closed_at |
| `gh api repos/<repo>/pulls/<id>` | T1 | PR head SHA + merge_state |
| `gh api repos/<repo>/commits/<sha>` | T1 | commit SHA (immutable) |
| `git ls-tree / cat-file` | T1 | tree/blob SHA |
| `TaskStore.get(taskId)` | T1 | task updated_at |
| `ThreadStore.get(threadId)` `threadKind` | T2 | thread updated_at (context signal only) |

**Limitation**：`threadKind` 是 context signal，**不**是 truth source（R3 critical: 不能独立裁决）。

### 4. Callback / wait coverage

**用途**：claim "等 X 回我" 时核 X 真能回（不是凭空 timer）

| Resolver | sourceTier | 输出 |
|---------|-----------|------|
| `TaskStore.find(kind='pr_tracking', subject=<PR url>)` | T1 | tracking task or null |
| `TaskStore.find(kind='issue_tracking', subject=<issue id>)` | T1 | tracking task or null |
| GitHub webhook binding `(repo, event_type)` exists | T1 | binding active or null |
| `ScheduledTaskStore.find(kind='hold', thread=<id>)` | T1 | scheduled task or null |
| EYES counter on subject message | T1 | reaction count |
| reporter SLA / explicit deadline in `WaitSourceRef.slaUntilMs` | T1 | timestamp |

**Rule (R3.1)**：

- `hold_ball` 必须能反推到上述至少一个 callback；缺 → `WaitSourceRef.slaUntilMs` REQUIRED + short SLA
- 已有 event/callback → **不调 `hold_ball`**，但 ownership valid 时 **keep event-backed tracker**
- 长 / 不可预测 wait → 路由 daily sweep / needs-info

### 5. Cross-thread routing

**用途**：claim "这是 thread B 的活" / 跨 thread 派单

| Resolver | sourceTier | 输出 |
|---------|-----------|------|
| `cat_cafe_feat_index({featId}).linked_threads` | **T2** (cat-writable; 与 row 1 一致) | thread list |
| `cat_cafe_list_threads({keyword})` | T2 | keyword match candidates |
| source thread context (lookup thread title) | T2 | narrative match |
| `gh api repos/<repo>/issues/<id>` labels + project | T1 | repo-level routing signal |
| `git log --grep="<thread/feat>" --author --signature` | T1 | commit signatures pointing to thread/cat |

**关键**（cloud R4 P1#1 修正 sourceTier）：`feat_index.linked_threads` 是 **T2 (cat-writable)** —
与 row 1 owner resolver 同源 (cat 可改)；**不**单独验证 high-risk routing。命中关键词更弱（T2）。
high-risk action（`takeover` / `owner_reassignment` / `merge`）的 `verified` verdict 必须 ≥1 个
T0/T1 evidence（per INV-O3）；T2-only feat_index 命中 → `insufficient` → 需要独立 GitHub/git/landy
T0/T1 evidence (gh api / git log signature / landy messageId) 二次 confirm。

### 6. Capability / role fit

**用途**：claim "你能做" / "你应该接"

| Resolver | sourceTier | 输出 |
|---------|-----------|------|
| Cat dossier 6 字段 (`docs/team/cat-dossier.md`) | T2 | 原生峰值 / 反信号 |
| Cat-config restrictions (model permissions, allowed tools) | T1 | hard limits |
| Current runtime identity (catId match) | T0 | self-identity |
| Family-level capability (Ragdoll / Maine Coon / Siamese / Bengal) | T2 | family taxonomy |

**Limitation**：dossier 是猫可写 (T2)；硬限制（如 "Siamese禁写代码"）在 cat-config (T1) 才是 enforcement。

### 7. Conflict / freshness

**用途**：claim "这是最新状态" / 检查 stale data

| Resolver | sourceTier | freshnessKey |
|---------|-----------|--------------|
| `git ls-remote origin main` vs local HEAD | T1 | commit SHA |
| `gh api repos/<repo>/pulls/<pr>` head SHA | T1 | PR head SHA |
| `cat_cafe_get_thread_context(threadId).lastMessageId` | T1 | message SHA |
| source message timestamp | T2 | message ts |
| 当前是否有更新的 verdict 覆盖旧 claim | T1 | verdict ts |

**Rule**：authorization / freshness / conflict resolver **必须** `freshnessKey` invalidation（不能仅 TTL）。

## Cache policy classed freshness

| Resolver class | Cache strategy |
|---------------|---------------|
| Object existence (1, 3, 6) | TTL 60–300s OK |
| Owner / capability (1, 6) | TTL 60–300s OK |
| Authorization (2a/2b/2c) | **freshnessKey only** (messageId / PR head SHA / review state) |
| Freshness / conflict (7) | **freshnessKey only** (commit SHA / message SHA) |
| Wait coverage (4) | TTL OK 但 `slaUntilMs` 单独校验 |
| Cross-thread routing (5) | TTL 60s (frequent invalidation OK) |

**实施 (PR-O2)**：`GroundingResolverCache.get(key, freshnessKey?)`，传 `freshnessKey` → 强制 key match；
不传 → TTL fallback。

## Resolver budget

- 每 invocation 15 calls hard cap（保守初值；按 rate-limit 校准）
- 每 stateful tool call 5 calls hard cap
- 耗尽 → verdict=`insufficient`, reason=`resolver_budget_exhausted`
- `cacheHit=true` 不消耗 budget；但 `freshnessKey` mismatch 时消耗

## Trigger boundary

**Resolver invocation ONLY** 在：

- cross-thread ACTION intake（即将建 worktree / 注册 tracking / hold / merge）
- `actionFamily ∈ {wait, register_tracking, merge, cvo_claim, takeover, irreversible, owner_reassignment}`

**Not on**：

- 每个 @mention（会爆 GitHub/feat_index API rate-limit）
- 纯阅读 cross_post（`actionFamily=read_intent`）
- 本 thread 内日常 reply

## R3.1 specific: ownershipState resolver (PR-O3 implement)

PR-O1 only document；PR-O3 实施：

```typescript
interface OwnershipStateResolverResult {
  state: 'keeper_owned' | 'distributed' | 'unknown';
  evidence: Array<{
    source: 'cross_post' | 'propose_thread' | 'task_assignment' | 'pr_routing' | 'existing_tracker';
    targetThread?: string;
    targetCat?: string;
    targetPr?: string;
    ts: number;
  }>;
  sourceTier: SourceTier;
  freshnessKey?: string;
}
```

**Verdict 规则** (PR-O3)：
- `keeper_owned` + explicit intake `sourceRef` → allow `register_issue_tracking`
- `distributed` → block (downstream owns)
- `unknown` → `insufficient`（不允许 keeper register；除非 explicit intake sourceRef）

**PR-O1 only**：document `existingTask?.ownerCatId` 是 evidence 的 **一个** input；不当 final verdict。
