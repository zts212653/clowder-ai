---
feature_ids: [F332]
related_features: [F148, F232, F296]
topics: [cold-recovery, review, test-evidence]
doc_kind: review-evidence
created: 2026-11-04
updated: 2026-11-04
---

# 冷恢复定位入口：代码复审与验收缺口

实现作者：宪宪 / claude-opus-5-5。独立 reviewer：砚砚 / gpt-6.1-sol。

代码审查对象：`3c94abdababc66873a02b584930489394ba38635`；实施合同：`9c79d069e0a382cf1359084cb77df75bf6085605` 的[冷恢复 spec](../../../feature-specs/2026-11-04-f332-cold-recovery.md)。审查结论仅覆盖本 PR 的代码正确性，不代表真实恢复验收、部署或 Phase 完成。

## 实现与审查结论

- M1b 从本猫在当前线程的 terminal response lifecycle 取得停点和来源坐标；每个坐标沿用可见性检查，不注入旧正文。无历史、扫描超窗和读取失败分别呈现。
- M1a 复用既有 anchor 选择，给省略区间和锚点的坐标；cold 路径不恢复锚点正文。hot/legacy、exposure 和 continuity 所有权未改变。
- 原实现的全局内存窗口会被邻线程流量挤掉；现已按线程索引读取。Redis 主扫描使用既有 recipient 投影，不读取 `content`、`contentBlocks`、`thinking`、`metadata` 或 `toolEvents`。未新增 store、投影 API、缓存或回退层。
- 主扫描至多 100 行。`extra` 和专用权威字段仍整字段读取；来源核验仍有最多 6 次完整 `getById`。**这是行数及字段选择限制，不是完整过程的字节上界。**
- 两项读取 P2 已修正，独立复审通过。新增测试针对真实跨线程失败和大正文块读取，不以 helper 输出代替模型消费。

## 可复跑检查

在 feature checkout 构建 API 后，从 `packages/api` 执行；使用仓库 wrapper 隔离 HOME，Redis runner 自建并核验临时实例，不传入日常 Redis 地址。

```sh
node ./scripts/with-test-home.mjs \
  --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 \
  node --import ./test/helpers/setup-cat-registry.js \
  --test --test-concurrency=1 --test-timeout=60000 \
  test/f332-cold-resume-entry.test.js \
  test/message-store-bounded-pages.test.js \
  test/f296-a4-sparse-prompt-acceptance.test.js \
  test/f148-context-transport.test.js \
  test/f148-navigation-context.test.js

node ./scripts/with-test-home.mjs \
  --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 \
  node ./scripts/run-isolated-redis-tests.mjs -- \
  node --import ./test/helpers/setup-cat-registry.js \
  --test --test-concurrency=1 --test-timeout=60000 \
  test/f332-cold-resume-redis.test.js \
  test/f232-artifact-read-cost.test.js
```

Reviewer 独立结果：第一组 **137/137 PASS**；第二组 **3/3 PASS**。Redis 夹具含每行约 56 KB 的正文块：主扫描字段不含这些块，仍能找到停点；1 个来源完整读取 1 次，8 个来源只核验最新 6 个并列出最新 3 个。

作者另外报告：相关 156 文件共 1987 用例，1984 通过、3 跳过；F332 TypeScript 用例 48/48。此前一次 TS 失败的完整输出未保留，9 次保留日志均未复现；原失败原因仍未知，不据此断定无关。

## 已知的基线失败

`f232-artifact-projection-boundary.test.js` 的 Redis 用例期待文件 DTO 没有 `mime`，当前 aggregator 已输出 `mime: 'application/pdf'`。本 PR 未修改测试或 aggregator，二者源码与 `9c79d069` 逐字相同。Reviewer 使用改动前的编译模块镜像、原测试入口和规范隔离 Redis runner 实际重放，也复现相同的多字段断言；这不是一次完整基线重新构建。它不经过新增停点扫描路径，本 PR 保留该失败事实，不混入附件 DTO 修正。

## 尚未验收

真实模型请求数为 **0**。原 L0 编译、原 MCP 工具、真实鉴权 callback reader 已在合成隔离存储中接通；当前 evidence fixture 仅有 lexical 检索，不能声称覆盖 semantic-ready 情况。

仍待：S1a/S1b 的同模型 fresh A/B、实际工具消费和下一步产物、完成/撤回及状态更新后的正确动作、重复 unknown→cold 与 native resume 的区分、完整输入/读取/耗时/重复材料成本，以及自然使用证据。Task 指针增量未实现，须由剩余状态缺口的证据决定。

PR 因此保持草稿，Feature AC 保持未完成。若现有 A 已足够且定位增量未改善结果或恢复成本，按 spec 删除或延期增量，不先宣称恢复收益。
