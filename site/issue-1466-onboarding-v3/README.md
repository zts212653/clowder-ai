---
feature_ids: [F171, F155, F229, F320]
topics: [onboarding, prototype, issue-1466]
doc_kind: prototype-guide
created: 2026-10-12
---

# #1466 新版首启高保真

> 历史预研原型，已退出本轮交付路径。2026-10-12 用户要求直接在真实项目中配置自己的伙伴并完成小目标，不再以演示或独立 HTML 验收。当前实现见 [本机伙伴引导方案](../../docs/plans/issue-1466-native-onboarding-2026-10-12.md) 和 [真实验证记录](../../docs/plans/issue-1466-native-onboarding-validation-2026-10-12.md)。本目录保留用于追溯，不代表正式应用当前行为，也不代表原母 issue 的演示范围已获维护者关闭。

设计依据与讨论逐条对照见 [体验方案](../../docs/design/onboarding-experience-2026-10-12.md)。
本目录仅是设计原型，不被生产构建引用，不连接 API、Redis、CLI 或真实登录。

## 运行和演示

从本目录运行 `node serve.mjs`，打开 <http://localhost:5136/>。
服务仅监听回环地址；无需安装依赖或启动 Redis。
需要后台保持时，从仓库根目录使用既有托管入口：

```powershell
node scripts/preview-process.mjs start --port 5136 --cwd G:/AIwork/clowder-ai/worktrees/feat-onboarding-first-run/site/issue-1466-onboarding-v3 -- node serve.mjs
```

右上角“原型场景”（或 H）可以切换 8 个初始条件；切换新建演示记录，不删除旧记录。
地址中的 `run` 标识本浏览器演示记录，刷新续接。无 `run` 地址会新建记录。
键盘：空格暂停示范，左右方向键逐幕查看，Escape 关闭评审面板/弹层。

建议按以下顺序体验：

1. 一个已配置工具：认识伙伴 → 三猫协作 → 推荐清单 → 调整名字/模型 → 确认 → 输入自己的第一句话。
2. 多个工具：Codex 配置可读、Claude 需要登录、DSH 已有 API 配置；未选择的未登录项不阻塞。
3. 登录：按页面进入账户与登录，评审面板模拟成功/失败/取消；刷新后仍是等待，返回保留草稿。
4. 部分创建失败：成功项保留，重试不重复；也可先使用已创建项。
5. 首条回复失败：输入已保存不等于收到回复；刷新后可重试，不重复发送用户消息。
6. 没有工具 / 状态读取失败：不能直接确认。安装入口只预演外部返回，不实际安装。
7. 已有成员：直接进入对话，空固定列表保留；可主动重看示范，不要求重建伙伴。

模型目录、探测结果、创建和回复都是样例。登录结果只有通过评审控制才改变，不收集任何凭据。
账号新增不自动换绑；原型中的新增账号仅模拟 Codex，以明确正式版须按 F320 后端实际能力展示。
“原 issue 默认固定 / Workspace 默认不固定”为待决定的评审对照，不代表已有共识。

## 验证

```powershell
node --test site/issue-1466-onboarding-v3/journey.test.mjs
node node_modules/@biomejs/biome/bin/biome check site/issue-1466-onboarding-v3
```

浏览器点击记录和限制见 [验证记录](../../docs/design/onboarding-experience-2026-10-12.md#8-本轮验证记录)。
原型没有运行正式 Web/API 全量测试；其状态测试不能替代真实登录、服务端幂等、CLI 调用或生产数据兼容性验收。

## 素材与边界

- 三猫坐、走、挥手、理毛精灵图来自 `upstream/feat/onboarding-journey-prototype` 的 `site/onboarding-first-run/assets/cats`，提交 `9832a4a8f22867d343763edf35021a4090a30e85`。
- Logo 来自本仓库 `site/assets/logo-transparent.png`；没有生成替代猫形象。
- 设置布局以 `bc76776942d5508d74fde5a03c44362f43e55ba0` 的新版成员设置为对照；HTML 复刻语义和布局，尚未挂载 React SettingsShell。
- 动画是分幕预演（输入、初稿、审阅、采纳、交接）；没有宣称复用完整 canon 行为引擎。正式实现继续沿 FirstRunQuestWizard 的唯一入口。
- 当前存储为浏览器 `localStorage`，仅保存本原型演示数据。生产版需用户＋引导版本的服务端状态。
- 生产 runtime、3003/3004、生产 Redis 6399 均不参与本原型。
