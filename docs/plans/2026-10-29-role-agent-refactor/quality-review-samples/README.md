---
feature_ids: [F032, F127, F143, F161, F241]
topics: [agent-quality, review, calibration]
doc_kind: acceptance-fixture
created: 2026-10-30
status: private-evaluator-material
---

# Q02 固定审查样本：评估者材料

本目录根 README、manifest 和仓库内校准测试属于评估者，不发给盲审候选。每次只将 Q02-A、Q02-B 或 Q02-C 对应的完整子目录复制到新的独立任务目录；子目录内仅有 TASK.md 与 before/after 源码。候选只接收该任务目录，不给工作区根、答案或上一轮结果。这里只提供盲审材料的分离，不声称它是防作弊沙箱。

从仓库根准备一份材料，示例目标需替换成实际绑定/轮次/样本的全新目录：

```powershell
$sampleId = 'Q02-A'
$sampleRoot = (Resolve-Path -LiteralPath 'docs/plans/2026-10-29-role-agent-refactor/quality-review-samples').Path
$taskDestination = 'G:\AIwork\clowder-ai\worktrees\role-agent-refactor-20261029-gpt-sol\artifacts\role-agent-refactor-20261029-gpt-sol\quality-candidates\binding-round-1-Q02-A'
if (Test-Path -LiteralPath $taskDestination) { throw '任务目录已存在，必须选新路径。' }
$taskParent = Split-Path -Parent $taskDestination
New-Item -ItemType Directory -Path $taskParent -Force -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath (Join-Path $sampleRoot $sampleId) -Destination $taskDestination -Recurse -ErrorAction Stop
```

评估者在调用前确认复制后的三份文件与 manifest 对应 SHA256 一致，调用后复核全部材料未被改写。报告留在目录之外，并保存完整调用/工具记录；记录绑定、客户端实际版本、模型/载体/账号模式、native/Host session 与轮次，敏感值只存原有私有证据。每个目标绑定三项各两轮；样本顺序可改变，但不挑选重试结果。不能把校准测试或参考审查计作真实 Q02 完成。

## 答案及裁决

| 样本 | 指定关键事实 | 必须给出的有效证据 |
|---|---|---|
| A | after 的缓存命中绕过 owner 校验，造成跨用户文档泄露 | 同一 reader 中 Alice 先读取其文档，再由 Bob 读取相同 ID；before 为 null，after 返回私有文档。只说“缓存有风险”或仅测冷拒绝不够 |
| B | 移除已有 owner lock 后，并发成功回执超出容量 | 同 key 两个 amount=4、limit=5 并发请求；before 仅一项成功，after 两项成功，尽管最终计数仍为 4。不得只以最终计数未超过 5 推断正确 |
| C | 在已声明的 ASCII 字符串边界内，Set 变更保持全部契约 | 首次拼写与顺序、空项、重复项及输入不变成立；没有指定阻断缺陷。范围外 Unicode/类型处理及风格偏好不得编造为阻断 |

审查裁决由独立评估者逐条核对真实报告、触发路径与验证证据；不靠关键词命中或要求相同措辞。A/B 漏掉指定事实判失败；C 只接受无虚假阻断的结论。候选发现额外问题时独立复现，符合任务边界则按真实问题处理，先更新评估记录；若推翻样本健康性则停止以该版本打分、另建版本，不改答案给原结果补分。样本失效、工具不可达、发送未知与“无问题”必须分别记录。

量尺 claim 是“在这三份固定变更中能否发现两个指定回归，并正确通过健康对照”，不外推到整体审查能力、漏洞发现率或统计成功率。规约 owner 为 accepted《实施与验收》4.1；作者维护材料；独立 reviewer 校准事实与边界；真实验收执行者保存未经筛选的原始记录并裁决。0/1/2 的任务、身份约束、证据诚实、交接维度沿总方案分别记录，严重安全/虚假成功不由总分抵消。

## 校准与状态

`manifest.json` 固定九份候选材料及校准程序的 SHA256。校准入口从仓库根运行：

```powershell
node packages/api/scripts/with-test-home.mjs node --test --test-reporter=spec ./test/role-agent-review-samples.test.js
```

四条校准检查覆盖原始/变更的真实行为、健康对照和材料完整性。作者首次三个行为检查通过，证明 A/B 已知回归可复现、C 满足声明边界；这不是候选审查通过证据。加入 manifest 后四条检查通过，独立 review 回执见下。当前仅完成量尺准备，Q02 真实绑定两轮盲审继续 NOT_RUN；Q03/Q04 另行准备和验收。

checkpoint_review 对 `4c91c38852737620d90ac941b0d955d6b8e2c5aa` 给出 approved，无未关闭 P1/P2。独立 9 PASS 覆盖正式入口、临时 index 的 Windows 检出哈希、文档复制边界，以及健康 C 的额外 514 组 ASCII 输入等价检查。该回执只批准样本校准；未执行真实候选盲审，不计为 Q02 通过。

复杂度复核：九份静态材料、一个私有 manifest 和四条校准测试，不新增评分服务、数据库、通用 benchmark 平台或自动关键词裁决。
