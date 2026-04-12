---
feature_ids: [F155]
topics: [guidance-engine, scenes]
doc_kind: note
created: 2026-03-27
---

# F155 引导场景清单

> **原则**：核心引擎先做完 → P0 验收通过 → 再逐场景迭代补全。
> 所有场景用同一套编排文件 + 元素标签体系，实现流程一致。

## 实施策略

```
Phase A: 核心引擎 + P0 内部场景（添加成员）
Phase B: 双向可观测 + P0 外部场景（飞书对接）
后续迭代: 按优先级逐场景补全 YAML 编排 + 截图资产
```

## 场景总览

### 一、成员与账户配置

| # | 场景 | 复杂度 | 跨系统 | 优先级 | 涉及组件 | 说明 |
|---|------|--------|--------|--------|---------|------|
| 1 | **添加成员** | 极高 | 否 | **P0** | HubCatEditor | 10+ 表单段（身份/路由/账号/策略/Codex 设置），新用户最常问 |
| 2 | 配置 API Provider | 高 | 否 | P1 | HubProviderProfilesTab | 凭证管理 + 模型发现，新部署必经 |
| 3 | 设置 Co-Creator 个人资料 | 中 | 否 | P2 | HubCoCreatorEditor | 头像/别名/品牌色，首次使用时引导 |

### 二、IM 连接器对接

| # | 场景 | 复杂度 | 跨系统 | 优先级 | 涉及组件 | 说明 |
|---|------|--------|--------|--------|---------|------|
| 4 | **飞书对接** | 高 | 是 | **P0** | FeishuAdapter + HubConnectorConfigTab | 创建飞书应用 → 配权限 → 填凭证 → 配 Webhook → 验证连通 |
| 5 | 微信个人号对接 | 高 | 是 | P1 | WeixinAdapter + WeixinQrPanel | 检查微信版本 → 打开扫一扫 → Console 生成二维码 → 扫码 → 发消息验证 → 打开微信 DM 会话 |
| 6 | Telegram 对接 | 中 | 是 | P1 | TelegramAdapter | @BotFather 创建 Bot → 获取 Token → 填入 Console → 验证 |
| 7 | 钉钉对接 | 高 | 是 | P1 | DingTalkAdapter | 创建企业应用 → 配 Stream 模式 → 填 AppKey/Secret → 验证 |
| 8 | 企业微信对接 | 高 | 是 | P2 | 待实现 (F132 Phase B/C) | 依赖 F132 后续 Phase |

### 三、系统功能配置

| # | 场景 | 复杂度 | 跨系统 | 优先级 | 涉及组件 | 说明 |
|---|------|--------|--------|--------|---------|------|
| 9 | 开启推送通知 | 中 | 否 | P1 | PushSettingsPanel | 浏览器权限请求 → 订阅 → 测试推送 |
| 10 | 管理猫猫能力 | 中 | 否 | P2 | HubCapabilityTab | MCP/Skills 全局 + 按猫开关，多作用域容易误操作 |
| 11 | 治理看板配置 | 中 | 否 | P2 | HubGovernanceTab | 多项目发现 + 同步状态管理 |
| 13 | 权限白名单/命令管理员配置 | 中 | 否 | P1 | HubPermissionsTab | 安全边界入口，误配会导致非管理员执行敏感命令 |
| 14 | 路由策略配置 | 中 | 否 | P2 | HubRoutingPolicyTab | Review/Architecture 路由偏好，误配导致任务分发偏航 |

### 四、GitHub 集成

| # | 场景 | 复杂度 | 跨系统 | 优先级 | 涉及组件 | 说明 |
|---|------|--------|--------|--------|---------|------|
| 12 | GitHub PR 自动化配置 | 低 | 部分 | P2 | 内置连接器 | Token 配置 + 仓库绑定 |

### 五、运维与恢复

| # | 场景 | 复杂度 | 跨系统 | 优先级 | 涉及组件 | 说明 |
|---|------|--------|--------|--------|---------|------|
| 15 | 连接器失效恢复 | 中 | 是 | P2 | 各 Adapter + HubConnectorConfigTab | Token 过期/二维码失效后的重连路径，区别于首次接入 |

## 场景详情（P0 + 部分 P1 展开）

### 场景 1: 添加成员（P0，纯内部）

```
前置: 无
步骤概要:
1. [console_action] 打开 Hub → 成员总览
2. [console_action] 点击"添加成员"
3. [console_action] Step 1: 选择 Client（Claude/Codex/Antigravity）
4. [console_action] Step 2: 选择 Provider Profile（从已配置的账号中选）
5. [branch] 如果没有 Provider Profile → 跳转"配置 API Provider"子流程
6. [console_action] Step 3: 选择模型
7. [console_action] 完成创建
8. [console_action] 编辑成员详情（别名/颜色/路由策略）
9. [verification] 验证成员可响应（发送测试消息）
预计时间: 5min
```

### 场景 4: 飞书对接（P0，跨系统）

```
前置: 无
步骤概要:
1. [external_instruction] 打开飞书开放平台，创建企业自建应用
   - assets: 2 张截图（创建应用界面 + 机器人能力开关）
   - link: https://open.feishu.cn/
2. [external_instruction] 配置权限（im:message + im:message:send_as_bot）
   - assets: 1 张截图（权限列表）
3. [collect_input] 复制 App ID + App Secret
4. [console_action] 打开 Hub → 连接器配置
5. [console_action] 填入凭证（auto_fill_from 自动填充）
6. [external_instruction] 在飞书配置事件回调 URL
   - template_vars: webhook_url
   - assets: 1 张截图
7. [verification] 连通性测试（verifierId: feishu-connection-test）
8. [information] 完成！去飞书给机器人发条消息试试
预计时间: 10min
```

### 场景 5: 微信个人号对接（P1，跨系统）

```
前置: 微信版本 ≥ 8.0.50
步骤概要:
1. [information] 前置条件声明：微信版本要求
   - assets: 1 张截图（版本检查位置）
2. [external_instruction] 打开微信扫一扫
   - assets: 1 张截图（微信扫一扫入口）
3. [console_action] 打开微信对接页面 → 生成二维码
4. [external_instruction] 用微信扫描屏幕上的二维码
   - assets: 1 张截图（扫码界面）
5. [verification] 等待扫码成功（verifierId: wechat-qr-scan）
6. [information] 扫码成功！现在发一条微信消息试试
7. [console_action] 引导用户打开左侧出现的微信 DM 会话
   - observe: { fields: [{ key: wechat_dm_visible }], on_idle: 30s }
8. [information] 微信对接完成！
预计时间: 5min
```

### 场景 6: Telegram 对接（P1，跨系统）

```
前置: Telegram 账号
步骤概要:
1. [external_instruction] 在 Telegram 找到 @BotFather
   - link: https://t.me/BotFather
2. [external_instruction] 发送 /newbot，按提示创建 Bot
   - assets: 2 张截图（创建流程 + Token 获取）
3. [collect_input] 复制 Bot Token
4. [console_action] 打开连接器配置 → Telegram
5. [console_action] 填入 Bot Token
6. [verification] 连通性测试
7. [information] 完成！去 Telegram 给 Bot 发条消息
预计时间: 5min
```

### 场景 7: 钉钉对接（P1，跨系统）

```
前置: 钉钉企业管理员权限
步骤概要:
1. [external_instruction] 打开钉钉开放平台，创建企业内部应用
   - link: https://open-dev.dingtalk.com/
   - assets: 2 张截图
2. [external_instruction] 启用机器人能力 + 配置 Stream 模式
   - assets: 1 张截图
3. [collect_input] 复制 AppKey + AppSecret + RobotCode
4. [console_action] 打开连接器配置 → 钉钉
5. [console_action] 填入凭证
6. [verification] 连通性测试
7. [information] 完成！在钉钉群里 @机器人试试
预计时间: 10min
```

## 资产清单（截图需求汇总）

| 场景 | 预计截图数 | 外部平台 |
|------|----------|---------|
| 飞书对接 | 4-5 张 | 飞书开放平台 |
| 微信对接 | 3-4 张 | 微信 App |
| Telegram 对接 | 2-3 张 | Telegram App |
| 钉钉对接 | 3-4 张 | 钉钉开放平台 |
| 企业微信对接 | 待定 | 企业微信管理后台 |

> 截图在实际编排时按 `guide-authoring` skill Step 5 准备，用橙色圆圈标出关键操作位置。

## 变更记录

- 2026-03-27: 初版 12 场景 (宪宪)
- 2026-03-27: 补 3 场景 (#13 权限配置 / #14 路由策略 / #15 连接器失效恢复)，基于砚砚补漏审计
