# 配额刷新成功但自定义账号仍显示暂无数据

## 报告人

co-creator Sean 于 2026-07-18 在 runtime 点击“刷新全部”后发现。

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | `POST /api/quota/refresh/official` 与随后的 `GET /api/quota` 均返回 200，但 `my-codex-account` 卡片显示“暂无数据”。期望卡片展示官方返回的额度池、百分比和重置时间。 |
| **2. 证据** | runtime PID 240126 启动晚于修复提交 `fa39a60b`；实时 `GET /api/quota` 返回 Codex `5小时使用限额`、`20% used`；`buildAccountQuotaGroups` 却以 `profile.id` 调用只识别 `claude/codex/gemini/kimi` 的 `builtinQuotaItems`。 |
| **3. 根因** | 配额缓存按平台组织，而 F127 账号按用户自定义 ID 组织。前端把账号 ID 误当作平台 ID；`my-codex-account !== codex`，导致已有 Codex 条目在账号归属层被丢弃。 |
| **4. 诊断策略** | 从 runtime 请求链逆向追踪：官方响应 → API cache → `GET /api/quota` → `buildAccountQuotaGroups` → 账号卡片，并以 F127 的 `accountRef`/`clientId` 契约对照。 |
| **5. 超时策略** | 若按 `clientId` 映射仍无法复现转绿，暂停修改并检查 `/api/accounts` 实际响应与 ProfileItem 类型是否漂移。 |
| **6. 预警策略** | 若修复需要为每个账号名添加别名或同时改 API 缓存结构，说明仍在以字符串补丁代偿错误坐标，应回到账号与平台的数据契约。 |
| **7. 用户可见交互修正** | 自定义命名的 OAuth 账号会在自己的卡片内显示官方额度行、已用/剩余百分比、进度条和重置时间。 |
| **8. 验收** | Web 回归测试用真实形状 `id=my-codex-account, clientId=openai` 验证 Codex 额度出现在该账号卡片；完整配额看板测试、类型检查和生产构建通过。 |

## 修复方案

用 OAuth 账号的 `clientId` 选择平台配额；继续用 `profile.id` 标识账号卡片并反向关联成员。没有采用账号名关键词或固定 ID 别名，因为账号 ID 是用户可定义值，不是平台真相源。

## 验证方式

先运行新增回归测试确认它因账号卡片缺少 `5小时使用限额` 而失败；修复后运行配额看板测试、Web 类型检查和生产构建。
