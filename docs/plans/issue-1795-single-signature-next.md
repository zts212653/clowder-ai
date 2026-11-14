---
topics: [issue-1795, codex, native-model-inheritance, message-signature]
doc_kind: plan
created: 2026-11-03
tips_exempt: 恢复既有回复签名收尾约定，没有新增用户入口或操作。
---

# #1795：空模型继承下的单签名修复

方案：宪宪/Opus；方案审查与实施：砚砚/GPT-6.1-Sol。

## 目标与范围

修复 [#1795](https://github.com/zts212653/clowder-ai/issues/1795)：原生模型继承允许模型名留空，当前代码却生成空型号 canonical 签名，既有 provider 签名未被剥离，收尾又追加空型号签名。

沿用 [#1272](https://github.com/zts212653/clowder-ai/issues/1272) 与 [#1277](https://github.com/zts212653/clowder-ai/pull/1277) 已接受的消息收尾契约：所有进度与正文保留，有有效签名来源时，最终消息只保留一个自身签名。保留原生模型继承及现有签名格式。

Architecture cell: bubble-pipeline

Map delta: none

Why: 修复既有 Codex provider 的签名采集与收尾，不移动消息解析、聚合或持久化职责。

## 方案审查结论

宪宪提出两处修复：模型名为空时不构造 canonical；finalizer 排除格式无效的 canonical，必要时使用已有 observed 签名，并正确标记来源。

砚砚审查发现必须补齐一处接线：`observedSignature` 仅从实际剥离出的尾签名赋值，而 `isCanonicalOwnSignature()` 原来在没有 canonical 时直接拒绝。因此仅做前两处，实际 provider 签名不会进入 observed 分支。直接预填 observed 状态的单测不能证明这条链路。

新增 service 与 route 回归已在修改实现前失败：空模型的 service 保留两段签名并追加空型号后缀；没有 canonical 的 route 保留全部 16 个进度尾签名。新增 transform 用例也复现了 observed 采集缺口与 finalizer 的无效 canonical 处理。

## 最终修改

1. `CodexAgentService.ts`：仅在模型名 trim 后非空时构造 canonical。处理只影响签名，不修改传给 CLI 的模型选择。
2. `codex-event-transform.ts` 的尾签名识别：有 canonical 时保持既有身份及模型比较；没有 canonical 时，仅允许当前身份或既有 alias、非空模型名且没有外部 catId 的尾签名进入 observed 分支。既有引用、围栏、缩进代码和其他成员边界继续生效。
3. finalizer：先选格式有效且模型非空的 canonical，再选 observed。`hostOutput.basis` 按实际选中的来源填写。

模型未知且 provider 没有提供有效尾签名时，保留正文，不生成空型号或猜测实际模型。provider 自报签名标为 `provider_observed_fallback`，不冒充运行时或上游已验证的 served model。

## 验证

- RED/GREEN：真实 `CodexAgentService.invoke()` 的空模型多 turn 回复，只保留一个签名，CLI 没有新增 `--model`。
- transform：没有 canonical 的签名采集、无效 canonical 不覆盖 observed、重复 finalization 不追加第二次。
- 内容保护：引用、未闭合围栏、缩进代码、其他身份、外部 catId、空白模型样例不被当作装饰签名移除；已知模型行为复用现有回归集。
- route：16 段不同正文全部保留；live、保存与回读一致，只有一个尾签名。
- F322：来源标记、host suffix 与原生输出范围一致；现有消息聚合及输出布局回归保持通过。
- 构建与检查：API 类型编译、受影响 provider/route/F322 测试、格式检查与 `git diff --check`。依据窄改影响范围选择验证，不将 unrelated 全仓失败作为修复完成的证据。
- 独立审查：非作者检查最终 exact HEAD，PR 目标为 `next`，门禁通过后由非作者合入。

## 排除与回退

不修改用户模型配置，不扩展 #976 的签名格式，不改 served model 门控和采集顺序，不做全文去重或历史消息迁移。

代码、测试和本计划组成一个可回退提交；回退该提交恢复原行为，没有持久化 schema 或数据迁移。合入 next 不代表已部署到用户当前桌面安装版。
