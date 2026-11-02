---
feature_ids: []
topics: [desktop, packaging, offline, performance]
doc_kind: validation-report
created: 2026-11-03
status: rebuilding-after-next-moved
---

# 最新 next 的包体优化复验

当前基线 `1016aa7a316566893cacef84d49792a8ced0f0c8` 已包含 #1762 / #1748 的 SDK 外置与打包 guard。本片只保留 gzip9、node-pty 五类已知异平台过滤和两项 cache 排除；不改变或重复计算 SDK 集成。

第一轮 `917120d5` 上的60.47 MB、双包、独立review和CI均是[历史结果](https://github.com/whutzefengxie-ops/clowder-ai/blob/e1db9ad24b1095085a82938a601d1fc18f7ae98d/docs/plans/2026-11-03-issue-1703-next-package-slimming-validation.md)，不是当前 next 的收益或批准。新收益暂不声明，待同输入双包、全文件比对和非作者新HEAD审查后回填。

方案见[实施计划](2026-11-03-issue-1703-next-package-slimming.md)。新工件集中 `G:/AIwork/clowder-ai/artifacts/issue-1703-next-20261103/latest-next-1016aa7a/`；父目录保留第一轮历史，不混用。

真实断公网首装、支持升级、失败恢复、完整UI/麦克风仍缺环境；保持Draft，不合入/发布/部署/关闭Issue。不使用用户当前安装和持久数据。
