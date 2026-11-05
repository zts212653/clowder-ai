# F202 Dot：迁移等价优先的范围调整（已获实施授权）

> 具体单槽方案 v4 已获 5.6 只读复核 approved，消息 0001793371272342-005069-dedf3b0b，精确 SHA256 cb55dd929daafc3eb64989756a28357f24f9a14349427b1955f3dfb687a9f078。只覆盖方案；共创者已在 0001793429159213-008193-fa43b2c9 允许按澄清后的边界实施。具体实施约束见 [2026-10-31 实施说明](2026-10-31-f202-migration-implementation.md)，不等于代码、账号验收或 soak 通过。

依据：共创者最新纠正「目标优先是迁移；不合理的改造应相对独立，迁移之后增量做」。本文件替换之前把新 OAuth 与完整向导并入 F202 的草案；该草案保留在 `.cat-cafe/acceptance/f202-owner-setup-future-draft.md`，不再作为本次迁移的实现门槛。当前仍只调整方案，没有开始 OAuth 或新向导实现。


具体单槽共享承载设计（v4：稳定身份、verified rebind、跨请求待确认记录、Host 整行展示校验、rows 精确回传、无 token 的共享 prepare）见 [F202 Dot 共享连接方案](2026-10-30-f202-dot-shared-connection-plan.md)；它是已复核的方案，不是实现收据；本轮授权与收窄边界以 2026-10-31 实施说明为准。

## 当前结论

先兑现业务与已有使用路径的等价迁移：Dot 的实现从 Host 内置搬进插件，原有连接、配对、数据、回复和图片继续可用。迁移所需的 Host 通用扩展与必要兼容可以保留；不能以清掉专用代码为由删除用户原来能走通的路径，也不能把重新设计认证平台作为迁移的先决条件。

## 迁移前的可核验基线

取迁移提交前的 upstream base `b2c9952f27d31480191ff6fd120789405c97238c` 源码交叉核对，不拿当前草案倒推历史：

| 方面 | 迁移前实物 |
|---|---|
| 正常云端接入 | DotConnectionDetail 明确写着「沿用 ChatGPT 已连接的猫咖插件」「Pro 会话与 dot 会话共用一个连接」「不要另装一份 dot 连接」 |
| 设置流程 | 主人准备订阅说明 → 在目标云端对话订阅 dot.summoned → 页面轮询真实状态 → 测两处来源的收到/读原文/原处回复 → 启用协作 |
| 公开地址 | 连接路由将配置的 public base 解析为 `/mcp`；prepare 返回订阅说明并主动去掉内部 credentialSecret，不要求用户另填 Dot token |
| 共享服务 | remote-spike 在原有 `/mcp` 注册四个 Dot 工具；remote-shared-dot 转发 events/list、subscribe、unsubscribe。原有连接的 outer auth 继续验证账号，不等于匿名业务调用 |
| 内部实现 | Host 的 DotConnectionService、DotEventsBridge、Return/Image/Ask 等服务与专用 UI/路由承担业务；gpt-dot 为专用成员身份 |
| 旁路兼容 | `/dot/mcp` 另支持 Dot 专用 Bearer 或 query token；它与正常共享 `/mcp` 是两个入口，不能混为一谈 |

旧版 prepare 对当前 public base 也有要求：没有 HTTPS 地址时明确阻断。外部依赖存在不等于 F202 需要新增一套授权产品。源码证明有这些流程，不证明这台隔离实例目前已经真实登录/配对成功。

复核命令：

```sh
git show b2c9952f27:packages/web/src/components/settings/plugin-manager/DotConnectionDetail.tsx
git show b2c9952f27:packages/api/src/routes/chatgpt-dot-connection-routes.ts
git show b2c9952f27:packages/api/src/domains/cats/services/cloud-bridge/dot/DotConnectionService.ts
git show b2c9952f27:packages/mcp-server/src/remote-shared-dot.ts
git show b2c9952f27:packages/mcp-server/src/dot-remote-proxy.ts
```

## 当前候选与基线的真实差异

Host `ded225ec3e6d6d4b96d041eb61c7ea6ac9214fcd`、Dot `07b2add0cb3a0c572fd01d1a86405ad4fac67190`：

- 已把主要 Dot 业务移入插件，使用安装实例寻址、固定 deliver/handle、Host 安装凭据以及旧数据导入围栏。
- `452df9a832672c13c82bd52e8ee6ab7425cdb165` 明确删除 remote-shared-dot 与共享 relay，取消原 `/mcp` 上的 Dot 工具/事件转发；当前 remote-modern-protocol 仅声明 tools，没有 events。
- 当前测试 `packages/mcp-server/test/remote-shared-dot.test.ts` 还明确断言 Pro MCP 不注册或转发插件工具。因此这是候选中有意识的结构改变，不是只少了一个按钮；是否曾有更早的用户范围决定需单独回读，不能用作者 commit message 冒充用户同意。
- 当前 `/plugin/mcp` 要求安装 Bearer；新安装用户被引导去重新添加云端连接。但旧主流程没有这一步，旧凭据导入测试不能代替共享连接兼容验收。
- 设置页变为独立操作按钮与 JSON，未保持旧版可理解的订阅说明、状态与往返反馈。

因此先前「网页不接受固定 Bearer，所以迁移必须新增 OAuth」的结论不成立。它只描述新建独立入口的兼容问题，没有覆盖旧版复用已有连接的主流程。

## 调整后的范围

### 本次迁移必须完成

1. Dot 业务移入插件；主人通过插件提供的配置/操作得到旧版等价的说明、状态、配对与往返反馈，不在 Host 保留 Dot 业务状态机。
2. 迁移前已经连接猫咖的用户可以继续使用原云端连接，不要求额外安装 Dot 连接、重填凭据或改用新认证体系。已有有效配对、订阅和历史内容保持。
3. 重新评估共享入口的移除，提供业务中立的承载/兼容方案，最终执行仍通过固定插件 handle；不能直接恢复旧 Dot 专用服务或把 Pro 密钥交给插件。复用原账号连接也不等于允许访问任意安装实例，必须校验主人/绑定/启用状态。
4. 固定 call/delivery/handle、稳定安装实例寻址、别名/图标、停用与卸载围栏不回退。Host 不新增按 Dot 名称判断的业务流程分支。
5. 原主流程与保留的专用兼容路径分别回归：共享连接 → 订阅 → 两处来源的读取/回复 → 原图；旧有效凭据、迁移幂等、历史数据、禁用/重装边界单独验证。
6. 包与 Host 在同一个 feature 工位配套验证，非作者复审，真实共创者体验与 fork soak 仍是原来的交付门槛。

共享承载契约以已复核 v4 与 2026-10-31 实施说明为准；先用旧版行为测试约束实现，不以方案批准宣称代码已经存在。

### 迁移之后单独评估

- 新建独立插件连接的标准 OAuth、client 注册、短期 access token 与 refresh/revoke 产品。
- 全新的多步骤连接向导、全自动部署检查、其它插件共同使用的新引导框架。
- 自动管理公网入口/隧道或新增账号平台。

这些可以改善产品，但应有独立提案与改动边界，不绑定本次迁移是否完成。原有说明/复制/反馈迁移丢失则属于本次要补的等价能力，不以「UI 优化后做」为由留空。

## 验收标准与接下来交付物

验收核心：实现位置迁移了，旧用户的能力与必要操作保持等价；需要新增的操作只能有已说明的迁移依据，不能让用户替架构变更付出一整套重新接入劳动。

下一份评审材料应包含：旧版与候选的能力逐项对照、共享入口的通用承载方案、插件配置页面等价映射、真实账号验证步骤与尚未验证项。先解决迁移闭环，再讨论新 OAuth 与完整新向导。

当前尚未完成：共享连接的候选修复与回归、真实云端配对/往返/原图验收、共创者确认与 fork soak。本轮只做源码考证与范围调整，没有改运行配置、凭据或生产代码。


2026-10-31 边界澄清：Dot 配对/回调凭据与轮换始终归插件。Host 沿用既有认证，不新增 Dot 密钥管理功能；本次补回原共享入口到已存在固定 handle 的接线。
