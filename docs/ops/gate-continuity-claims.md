---
title: 完整门禁通过后的 C2 连续性声明
doc_kind: guide
topics: [gate, continuity, verification]
created: 2026-09-25
updated: 2026-09-25
status: active
description: Gate owner 为一次已冻结的文档 base 增量记录 C2 判断，机器重算客观绑定，C3 仍须独立完成。
description_source: model
description_author: codex-astra
description_generated_by: codex-astra@gpt-6-astra
description_generated_at: 2026-09-25T19:04:54Z
description_confirmed_by: codex-astra
description_updated_at: 2026-09-25T19:04:54Z
---

# 完整门禁通过后的 C2 连续性声明

**消费入口仅适用于 canonical source checkout。** Public export 的 gate 不支持 `--continuity-claim`，会明确拒绝；导出的 CLI、library 和测试用于检查工件与验证合同，不代表公开仓已接通消费入口。

已有 full-green、作者补丁不变、base 只前进了无关文档时，merge-gate 允许 gate owner 做 C1/C2/C3 连续性判断。此入口把一次 C2 判断绑定到具体输入，避免分类器再次要求整套 full；它不证明程序从未读取某个文档，也不替代 C3 或合入门禁。

先完成一次有依据的 rebase，保持当前 worktree 干净。Gate owner 必须确认 base 增量的每个具体文件与此前执行无关，并在 Evidence Manifest 中保留理由和来源。浏览器真正使用的参考 JPG、测试 fixture 或运行配置不能因为放在 docs 下就声明为 inert。无法作出这个判断时继续 full。

## 生成与消费

Producer 通过 `git ls-remote` 实时读取 `origin` 的 `refs/heads/main`，要求 `--base-sha` 与该 SHA 一致；远端 URL 的单向摘要/ref/SHA 写入 packet。缺失或无法访问远端时拒绝，不退回缓存 tracking ref 或本地 main。它不改工作树；发现 base 已过期时，先重新评估 main 增量并整合，再显式生成新声明。Consumer 不再次联网，只消费已证明的 frozen cut；claim 生成后 main 才前进，不会自动解冻它，合入前仍由 merge-gate 核连续性。

以下例子假定旧完整门禁是 `pnpm gate --risk contract`，当前已整合到 `NEW_BASE`，且 base 增量只有所列两个文件：

```bash
node scripts/gate-continuity-claim.mjs create \
  --run-id OLD_FULL_RUN_ID --base-sha NEW_BASE \
  --actor codex-astra --source-ref thread_ID#MESSAGE_ID \
  --rationale '此次仅更新验收记录与截图；执行输入未变，C3 将补文档检查与类型检查' \
  --assert-inert-path feature-specs/example.md \
  --assert-inert-path project-evidence/example/screenshot.png \
  -- --risk contract
```

工具从 SQLite/Git 重算 receipt 状态、C1、base 差异、HEAD/tree、执行器和 invocation 身份；不接受调用者提供的这些结果。每个 `--assert-inert-path` 必须是机器算出的 exact delta 成员，且必须覆盖整个差异集合。首版只接受 plans Markdown、evidence Markdown/图片的具体 regular-file paths，禁止目录、glob、symlink 和 gitlink；新增/删除文件用明确的 null 前像/后像表示，存在的一侧必须有可读 blob。

输出包含 `claimHash` 与 Git 私有工件路径。将该 hash 和 C2 的 actor、sourceRef、理由写入 Evidence Manifest，然后运行：

```bash
pnpm gate --risk contract --continuity-claim CLAIM_HASH
```

保留原 invocation 的所有非控制参数；不要为加入 locator 凭空增加一个 pnpm `--` 分隔符。若旧调用原本带该字面分隔符，生成和消费时也必须保留。Locator 自身不进入旧 gate fingerprint。

消费不会 fetch/rebase 或修改旧 run。有效声明仅返回 **targeted / unverified，exit 3**，且 `mergeReady=false`、`reusesFullGreen=false`；仍欠风险匹配定向检查、跨包类型检查和 docs validation。完成 C3、独立 review 与现有合入授权后才能合入。过期或无效声明返回拒绝，不悄悄启动一轮 full；先查清拒绝原因，再选择新的合法验证路径。

## 证明边界

声明绑定 policy/schema、旧 run/fingerprint、old/new base、当前 HEAD/tree、argv、每个 inert entry 的 path/mode/OID 前后像和 requiredChecks。移除这些 exact entries 后，旧绿树与当前树剩余条目的摘要必须完全一致。模式位、重命名和未声明输入都会参与比较。

Actor/sourceRef 是 gate owner 的可审计声明，不是工具认证的新权限。JSON、一次 full-green、静态零匹配或一次 read trace 都不会自动签发“未读取”事实。忽略文件、生成物、绝对路径、网络及 Git object store 的读取也不由 tree digest 证明；C2 仍须承担这些语义边界。

“一次性”指一次 exact cut，而非读取一次即销毁。同一切面可幂等重读；HEAD/base、policy、命令、工具链、其他输入改变，或旧 receipt 被失效后，旧 claim 不再适用。工具不会自动刷新或续签。没有有效 claim 的路径继续使用原 full/targeted/reuse 分类规则。

Architecture cell: dispatch
