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

## 受限真实模型首批（2026-11-04）

范围：当前 Host 的 Codex 0.166.0（`data/tooling/bin`）、gpt-6.1-sol、effort high；合成数据，全新 session；A/B 两组使用同一受限工具面（代码模式 exec 隔离环境、禁用原生 shell/exec_command、无协作工具、看图被拒、只允许写工作区、cat-cafe MCP 去掉 7 个路径类工具，保留受工作区和白名单约束的 MCP 只读命令）。受限工具面先经无模型边界检查证明；验收执行器经非作者独立复审后才发起真实调用。S1a、S1b 各 A/B 一场。

| 场景 | 组 | 产物 | 模型实际发出的读取（合成 API 请求） | 返回条数 | 输入 token（含缓存） | 其中缓存 | 输出 token |
|---|---|---|---|---:|---:|---:|---:|
| S1a | A | 正确 | 普通窗口 `limit=60` | 3 | 234,493 | 179,968 | 865 |
| S1a | B | 正确 | 普通窗口 `limit=40`，未带坐标 | 3 | 178,672 | 138,240 | 877 |
| S1b | B | 正确 | `messageId`=原请求，带 `before/after` | 7 | 242,008 | 210,688 | 873 |
| S1b | A | 正确 | 普通窗口 `limit=100` | 77 | 262,254 | 230,144 | 829 |

四场 `result.json` 均与预先冻结的独立 oracle 一致。每场都是先读到完整原请求，再修改、回读，最后将合成 Task 标为 done；首包中没有原请求正文，执行器未加载 oracle；四场运行期审计均通过。

只限这四场的结论：

- **路径可行**：S1b 的 B 实际使用了 M1a 坐标，读取范围比 A 小。
- **S1a 的 B 收到了 M1b，但没有使用**，仍走普通窗口；AC-B6 / spec AC-1 要求的“S1a 确实消费 M1b”尚未满足。
- **A 组两场同样正确恢复**，本批不能证明成功率或可靠性提升。
- **token 差额不能归因于导航**：S1a 两组读取条数相同（各 3 条），B 仍少用 55,821 输入 token；S1b 的差额为 20,246。工具发现和输出量、exec 写法、缓存状态等也有差异，不能把差额全部归因于精确导航。每组只有一场，不能估计波动范围或稳定节省，不给节省比例。
- 四场都出现 WebSocket 超时后回退 HTTPS，耗时不作机制延迟比较。四场合计输入 917,427（其中缓存 759,040）、输出 3,444；没有美元账单，不换算费用。

保真缺口：

- 测试注册表模板（`cat-template.json`）中 codex 猫的默认型号仍为 `gpt-5.3-codex`，编译出的 L0 带旧型号身份文字，模型正文出现旧签名；实际推理模型经原生 trace 核实为 gpt-6.1-sol。日常身份呈现不在本批覆盖范围内。
- 合成 API 未实现 `/api/config`，每场 6 次 404；实际读源与 Task 操作均返回 200。

真实调用计数：本任务真实调用总上限 12 次（含失败）。本批为第 2–5 次；第 1 次是旧版 CLI 的请求被服务端以 `model_not_found` 拒绝，没有产生恢复结果。目前已用 5/12。逐场原始坐标、SHA256 与 token 明细由审核方保存（results.json SHA256 `e6b69ca309d92958cbee5883dbd6a78d345768bd620ae3d3f74fdbb5bb789caa`），作者从原始证据独立重算，结果一致。

## 尚未验收

AC-B6–B12 均未完成。仍待：

- S1a 中 M1b 的实际消费；
- 完成／撤回／需求更新后的正确动作（AC-B8）、不可读来源不泄露（AC-B7）、多工作歧义澄清（AC-B10）、降级与空态区分（AC-B9）；
- 重复 unknown→cold 与 native resume（S2）；
- 保留全部既有合法工具的 A 基线与完整成本（AC-B11）、semantic-ready、自然使用。

Task 指针增量未实现，须由剩余状态缺口的证据决定。

按 spec 第 6 节：本批中 A 已正确恢复，定位增量对结果和成本的改善尚未被证明。若后续批次仍是如此，应调整、删除或延期该增量；取得更多证据之前，不给出保留／调整／移除的具名结论，PR 保持草稿。下一批覆盖计划另行预注册，经独立审核后再执行。
