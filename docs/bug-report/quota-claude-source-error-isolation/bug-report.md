---
feature_ids: [F051]
topics: [quota, claude, concurrency]
doc_kind: bug-report
created: 2026-07-18
updated: 2026-07-18
tips_exempt:
  reason: Correctness fix for an existing quota-board capability; no new user action or discoverable capability.
---

# Claude 配额刷新来源错误隔离

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | “刷新全部”并发执行 Claude OAuth 与 ccusage；一个来源失败、另一个随后成功时，失败会从缓存和看板消失。HTTP 200 中的局部官方告警也不会展示。 |
| **2. 证据** | `refreshOfficialQuotaViaOAuth()` 与 `/api/quota/refresh/claude` 都写 `claudeCache.error`，且各自成功分支都会删除它；Web 只在非 2xx 时解析响应 body。 |
| **3. 根因** | 两个独立探针被折叠成同一个可变错误槽，成功无法区分应清除哪个来源；前端又把 HTTP 状态当作是否存在 warning 的唯一依据。 |
| **4. 诊断策略** | 枚举所有 Claude cache writers，分别模拟 official failure → CLI success 与 CLI success → official failure 的确定性完成顺序，并检查 200 warnings 的渲染链。 |
| **5. 超时策略** | 不依赖真实 CLI、OAuth、Redis 或调度时序；用纯状态转换与 mock Response 固定复现。 |
| **6. 预警策略** | 新增 Claude 探针来源时必须拥有独立状态键；任何来源成功只能清除自身错误，不得清除其他来源状态。 |
| **7. 用户可见交互修正** | 任一来源失败均持续显示，直到同一来源后续成功；官方部分成功返回的 warnings 即使是 HTTP 200 也可见。 |
| **8. 验收** | 两种相反完成顺序得到相同的 official failure；CLI/official probe 状态各读自身错误；Web 显示 HTTP 200 warnings。 |

## 修复方案

Claude 缓存分别保存 `officialError` 与 `cliError`，再确定性派生兼容字段 `error`。OAuth 和 ccusage 的成功/失败只更新各自来源，探针状态也读取各自来源。Web 对每个刷新响应都解析 `warnings`，不再以非 2xx 作为读取告警的前提。

## 验证方式

先让联合 Wham 响应、两种 Claude 完成顺序和 HTTP 200 warning 三类回归失败；实现后运行 API quota、Web quota、类型检查、生产构建及 diff 检查。
