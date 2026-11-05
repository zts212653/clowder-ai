---
feature_ids: [F155, F320]
topics: [testing, native-client, codex, isolation, cleanup]
doc_kind: bug-report
created: 2026-10-17
---

# 作者测试会话进入日常 Codex 最近列表

用户截图中的Identity/缅因猫和验收伙伴是本轮真实调用生成的原生会话。生成原生会话属于客户端机制；让大量作者验收会话残留在用户日常列表，是作者测试隔离与收尾缺口，不能称为用户应接受的正常结果。

## 根因与已核对范围

作者实例隔离了Clowder HOME、角色及Redis/SQLite；但`client-homes.json`的codex字段指向用户已有Codex HOME，以复用既有登录。这个HOME同时承载原生会话和索引，所以独立Clowder数据目录不能防止原生列表被测试填满。原先“配置/历史已隔离”的说法需要收窄，不能把原业务历史未被删除等同于没有新增原生历史。

首次只读列表中27条Identity验收条目均为notLoaded，不是27个正在运行的任务。26条通过作者验收记录中的Clowder thread ID，以及原生日志session ID、originator和作者cwd双重核验；另1条从原始Clowder调用journal补证：准备请求包含本次LIVE标记，且session_init到done对应同一原生ID，工作目录也属于作者实例。不能只凭相似标题认定归属。

## 已执行的恢复

用户明确允许可恢复归档已核验测试会话及以后同类作者测试会话。先备份27份原生日志、核对session ID/mtime/哈希及已知原生子代理创建记录，再用Codex提供的归档操作处理；没有直接改写用户SQLite或删除会话。

- 26条归档后，在活跃列表中为0，归档列表中26条均可回读；原先可见的非目标会话全部仍在。
- 补证后的第27条单独归档并核对原日志哈希；再次读取活跃列表，当前页Identity验收标题为0，当前工作会话仍可见。
- 27份原生日志哈希与备份一致，0删除。Clowder角色、消息与测试成功/失败证据均保留。
- 范围是本次明确核验的27条，不把标题扫描当全库清理，不动其他已归档/未核验内容。

私有证据相对`artifacts/pr1519-verified-build-20261016/e2e-20261017/`：`codex-native-test-thread-audit*.json`、`codex-test-archive-plan.json`、`codex-test-archive-receipt.json`、`codex-test-archive-file-readback.json`及`codex-test-archive-extra-{plan,readback}.json`。原生日志备份含私有上下文，只留本机，不上传PR附件。

## 后续验收边界

真实调用前必须核对原生HOME/状态根及既有会话是否共享；登录复用不等于历史隔离。当前用户允许共享登录下的已核验测试会话可恢复归档，作者在完整的续接/持久化测试后负责收尾。归档发生在完整验收结束后，不能提前归档破坏需要验证的原生续接，再声称续接通过。

不为解决列表问题启用全局ephemeral、不丢弃原生持久化或悄悄复制会旋转的OAuth凭据；这些会改变原接入和验收目标。只有新变更、失败或未覆盖疑点才新增真实模型调用，其他补证优先回读已有日志。共享状态根的产品配置策略和作者测试收尾分开，不擅自改变所有现有Codex账号的状态布局。

付费单聊与真实A2A测试现增加前置检查：读取指定作者实例实际client-homes，canonical化根并识别目录别名；共享根而未显式声明获授权的核验归档计划时，在创建对话/模型请求前失败。该声明不是归档完成证明，后续仍须有真实备份、原生ID对账与归档回读。它能阻止本次已知的共享HOME误判，不声称仅凭目录检查就完整证明了所有native config层的sqlite_home等覆盖。
