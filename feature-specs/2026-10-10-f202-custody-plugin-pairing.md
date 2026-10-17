---
feature_ids: [F202]
doc_kind: plan
topics: [plugin-framework, custody, authority]
architecture-cell: plugin
---

# F202 C1 custody 配对：Host 与包侧实施合同

状态：配对设计，尚未发布 contract/SDK，尚未实现或完成安装验收。
来源：C1 总览 `docs/plans/2026-09-21-f202-c1-contract.md`；operator043/006；
Host199 `thread_mu8dg6h7l2x4ohsk#0001791606345431-000199-4bf63aad`；
包203 `thread_mu8dg6h7l2x4ohsk#0001791606466261-000203-7c5d599c`。
Host 基线 `1bfe784157996d764ddde61f64c5e630abfdac56`；包侧审计基线 `4e58c5d`。

目标：插件业务可以提交完成证据，但仅 Host 能选择验证者、绑定冻结候选并提交原 lease CAS。
迁移不恢复 Host GitHub handler，也不让包持有第二份 custody 真相。
Host 实施由本 thread Astra 继续；contract/SDK/业务验证由原 W3 包 thread Astra 继续，本文不另派新责任。
Architecture cell: plugin + ball-custody。Map delta: 在现有 invocation carrier 内增加验证用途的私有分派，
并给原 lease 增加安装绑定；无新 HTTP/MCP verifier 入口、无第二套 lease store。
Why: 三个 Host 方法无法独自补齐被删除的独立 predicate 验证与实例归属。

## 对外声明与调用形状

采用包203的 `terminal-predicate-provider` contribution，封闭字段：
`type, id, actionFamily, predicateKind, subjectNamespace, freshnessMethod, completionMethod`。
它必须属于恰好一个 feature；feature 必须声明且获授 `custody.verify`。
类型字段沿用 Host 已支持的 action/predicate/subject vocabulary，不能借声明注册新的成功谓词。
同一安装中的重复选择键 `(actionFamily,predicateKind,subjectNamespace)` 拒绝；跨安装零/多匹配在准入时拒绝。
选择当前可用者之前先检查授权声明的歧义，不能因为其中一个进程暂时不可用便悄悄选另一个。

`custody.invoke` 单独控制业务侧三调用：

```ts
host.custody.canonicalize({ actionFamily, subjectRef, predicate }): Promise<{ digest: string }>
host.custody.preflight({ leaseId, generation, terminalPredicateDigest }): Promise<
  { ok: true; reason: 'active' | 'verified_success' } | { ok: false; reason: string }
>
host.custody.complete({ leaseId, generation, evidenceRefs }): Promise<
  { outcome: 'committed'; leaseId: string; generation: number } |
  { outcome: 'stale' | 'mismatch' | 'insufficient'; reason: string }
>
```

输入严格拒绝身份、时间、verdict、binding、callback 字段。Host 校验当前 native context，自己取时间。
缺 context / 授权拒绝是调用错误，不能返回成功或把 stored principal 当作 context。
preflight 的业务拒绝沿现有 `ActionSuccessorOutputPreflightResult`；额外 authority 拒绝原因由 Host 定义，
包不得把未知 reason 当通过。complete 继续使用现有结果 vocabulary。
cat/thread/user、实例与冻结 generation 的校验必须早于 succeeded replay 分支。

模块 `start` 返回可选独立 `predicateVerifiers` 表，键为声明方法名，值为 `(input, context) => Promise<result>`。
缺方法、额外方法、跨 freshness/completion 复用同一方法、与普通 actions 同名均拒绝；无贡献时不接受非空表。
SDK 从声明生成类型，Host 从实际归档验证声明和函数。方法不能出现在普通 action、MCP、HTTP 暴露表。
仍复用同一个 runtime carrier；内部区分 action 与 verifier 调用用途，外部 action 输入不能切换用途。
当前支持 builtin 模块；其他 carrier 未实现专用验证上下文时明确拒绝该贡献。

## 验证输入与第二上下文

两个方法输入共用 `{ actionFamily, subjectRef, predicate }`，其中 predicate 是完整 Host canonical 对象：
`kind, subjectRef, identityKey, freshnessKey, digest` 及该谓词适用的 revision 字段（review 为 `headSha`）。
不让包自行计算、替换或补齐 digest。completion 另外接收 `{ leaseId, generation, evidenceRefs }`；
不暴露候选版本让包填写。数组与对象传入只读快照，包改动不得影响 Host 候选。

第二参数 `context` 由 Host 创建，业务 input 不能填入：

- `phase: 'freshness' | 'completion'`，`tenantScope`，`installationProjectRoot`，`binding`，
  `signal: AbortSignal`，`assertCurrent(): Promise<void>`。
- freshness：`principal: { catId, threadId, userId }` 取真实准入 actor/source，
  `assignment: { holderCatIds, holderThreadId }` 取 Host 准入请求。
  不要求、也不伪造 native invocationId；初次准入尚无 lease。
- completion：principal 增加真实 `invocationId`，assignment 取冻结 lease；
  lease holder、调用者、tenant、当前包实例必须匹配。无后台 principal 冒充。

验证调用清除/屏蔽业务 `PluginCallContext` ALS。包 verifier 即使拿着 `host.custody` 闭包也不能递归 complete，
也不能继承触发它的业务调用身份。Host 内部仍保留自己的调用 fence 作前后检查。
不能把包的 assertCurrent 自觉调用当作 Host 的唯一检查。超时/取消/异常均不得进入成功 CAS。

freshness 结果：

```ts
type FreshnessResult =
  | { status: 'verified'; evidenceRef: string; freshnessKey: string;
      ownerCatId: string; holderThreadId: string }
  | { status: 'mismatch' | 'insufficient'; reason: string };
type CompletionResult =
  | { status: 'verified'; evidenceRef: string; predicateDigest: string; freshnessKey: string }
  | { status: 'mismatch' | 'insufficient'; reason: string };
```

返回严格校验；不得返回 tenant、approvedDelegates、candidateRevision、evidenceDigest、committed 等权限字段。
freshness 必填 owner/thread（不能利用现有 Host 类型的可选字段绕过 standing）；Host 自己注入可信 tenant。
Host 将 completion 结果交给 `bindActionCompletionVerdict`，并保留现有 digest/freshness/evidence membership/CAS 检查。

## 持久安装绑定、范围与生命周期

Host-only 持久字段 `terminalPredicateProviderBinding` 写入原 lease，包含：
`pluginInstanceId, packageDigest, featureId, contributionId, freshnessMethod, completionMethod,
grantRevision, lifecycleRevision, tenantScope, installationProjectRoot`。
选择键从冻结 predicate 派生并与声明核对，不再存另一份可分叉的选择规则。
其中 lifecycleRevision 是现有持久 owner/config fence；瞬态 activation handle 仅活在内存，不能写进 lease。

现有 inventory 本身无 tenant/project 字段。实际生产组合用 `resolveActiveProjectRoot()` 选择独立 inventory，
并已有 `privateUserId`（index.ts）作为本 Host owner。因此本片仅由可信组合显式绑定 owner + inventory project root；
不从第一个来访者、manifest、插件返回值或当前安装列表反推 tenant。不授权其他 tenant 使用该库存。
`installationProjectRoot` 是安装范围，不能冒充 conversation thread 的业务项目；线程身份/归属仍由 Host 检查。
未注入可信 owner/scope 时，custody provider 不可用；不创建多租户默认通配。

| 事件 | 绑定规则 |
|---|---|
| 初次 claim | 从本授权安装范围选择唯一 provider；真实 freshness/standing 通过后，在 claim 同一次 CAS 存绑定 |
| replace / fresh continuation | 重做选择、freshness、standing；与新 generation/lease 一起持久化，不遗漏任一分支 |
| 旧 lease 缺绑定 | 拒绝插件结算，不依据当前安装者补填；旧数据保留 |
| 普通 restart / runtime recovery | 同实例、package、grant/lifecycle revision 全相同时可接续；等待真实重新激活后调用 |
| disable / revoke / upgrade / reinstall / config 变化 | revision 或实例不匹配即拒绝；重新启用不能让旧 generation 静默重绑定 |
| 启停中 crash | 现有 restart recovery 会推进 lifecycleRevision，旧绑定拒绝；不修改既有恢复策略 |
| 完成重试 | 仍先校验绑定、身份和当前权限，再读取既有完成结果，不重复提交 |

provider IO 在库存锁外执行。调用前后检查 grant/package/lifecycle/activation 与 native fence。
最终 claim / candidate write / completion CAS 在同一 Host 库存串行区重新验权后执行，避免检查后撤权抢先但仍提交。
锁内不调用包、不做 provider IO、不重新进入 inventory.snapshot；native guard 必须拆出不会重入该锁的 invocation 检查。
候选/lease 并发仍由原 Redis CAS 判定；不复制到文件库存。事务队列是单 Host 进程保障，不能声称多进程共享库存线性化。

## 包业务的独立事实要求

包 `settlePending` 后台只能采集/协调，真实 owner invocation 续办结算。
先 complete 后 `case.review_verdict_recorded` 的顺序不变；verifier 不要求未来事件，也不递归 record。
先持久化真实认证提交意图，再独立读取 assignment/head 代次与 provider 对象，await 后复查 assignment。
普通 issue comment 的空 commit、不可信 publisher 关联、inline original/current commit 差异不能用 URL/body 自报补足。
缺事实返回 insufficient；现有 private pending 状态不是 Host success proof。

## 实施与验证

1. 包侧在原 W3 做封闭 schema/type、两项 grant、SDK 三调用与独立 verifier 表，提供实际打包归档和公开导出。
   本文的签名是实施目标，不能把源代码 dependency 改动当归档已可消费。
2. Host 复用 runtime-carrier/declared contribution 生命周期，实现专用分派与 scoped provider registry。
   将已授 scope/当前库存与 handler 存活分开检查；覆盖零/多 provider、extra/missing handler、普通 action 访问拒绝。
3. Host 改原 ActionSubjectTruthResolver/admission/completion/state machine 和实际 Redis 序列化，
   覆盖 initial/replace/fresh/恢复全部路径与原 task resolver 无回归。
4. 三调用接 module host 和真实 index 组合；无 context、伪身份、错 tenant/thread/实例、已撤权 replay、
   await 中 disable/upgrade、候选被替换、重启同绑定/变绑定、verifier 递归调用均有行为反例。
5. 同一 feature WT 用实际新版归档准入/激活/调用，再用插件真实验证入口和安装旅程验收。
   缺可信 publisher 事实时验收诚实拒绝，不能用 fixture 绿宣称 live delivery 成功。

采用现有 `packages/api/test` Node test + 隔离 HOME wrapper；有状态用自有临时 store，禁止运行实例数据。
测试/build 经托管 runner；实际 argv 和归档摘要在 runner 冻结时记录。文档/代码 diff 用 `git diff --check`；
有 TS/JS 改动时用已存在的 `pnpm biome format --write <本次文件>`，最终按实际 delta 跑 canonical checks。
Host/SDK/包组合未落地前，三调用、binding、dispatcher 和完整 C1 均保持未完成。
