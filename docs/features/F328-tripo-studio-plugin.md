---
feature_ids: [F328]
related_features: [F247, F202]
topics: [tripo, modeling, plugin, chrome, native-messaging]
doc_kind: spec
created: 2026-10-16
description: "后台读取 Tripo Studio 候选，把已选模型带回本地，服务猫猫星球建模。"
description_source: human
description_author: codex61-sol
description_updated_at: 2026-10-16T18:38:00Z
---

# F328: Tripo Studio 插件｜后台审模与资产回流

> **Status**: in-progress | **Owner**: 小太阳·Maine Coon (@codex61-sol) | **Priority**: P1

## Why

Before：You 逐个旋转四个白模、截图、上传，让猫比较。
After：授权目标页面后，插件取得已有预览/模型，生成来源一致的比较材料；选定资产回到指定目录，接续 Blender。You 继续使用原前台。

授权：母线程 `[thread-id]` 的用户消息 `private-source-id`、`private-source-id`；批准执行线程 `[thread-id]`。原 Task `private-source-id` 留在母线程，子线程不复制、迁移。

## Current State

2026-10-20 新框架源码接入已完成：插件仓 [#85](https://github.com/zts212653/clowder-ai-plugins/pull/85) 合入 main `22c29f1cc8b779a9ebea8cddd63231231a9ae472`，[#87](https://github.com/zts212653/clowder-ai-plugins/pull/87) 随后转 main 并合入 `fe8df82bae742dd3aef4bf2f9dc1c82837ade3fd`。授权来自 You 本线程 `private-source-id` 及 `private-source-id`（CI 通过即直接合入，不再等待额外审查）。默认 CODEOWNER 门禁未改全局规则；本次沿该明确授权使用单次管理员合入，不声称 reviewer 已批准。

保留现有 MCP contribution，新增公开结构契约的 builtin 模块与 Settings 状态操作；安装、打开设置和启用不启动 Chrome、不准备 Native 注册，关闭设置或停用取消未完成探测。SDK 为可选辅助包，本次不新增 SDK 运行依赖或复制 Host 内部实现。审模版 19 项、订阅候选 26 项检查和隔离 Chromium 检查通过；两版均经当前仓 canonical/self-contained packer 从实际归档完成搬迁加载验证。#85 固定工具链本地 `gate:ci` 全 35 步通过（沿用已有 intake pack 例外）；远端 Contract CI #85 run `39389182479`、#87 run `39389180408` 均成功。

#85 squash 后，#87 只补历史连接提交 `65a4992d3e1024cec3ab1f5ee2d9aec8be1ba007`，没有文件变化：完整 tree `e54e0704b20366e502fb3859a66e16c4ecdf2af5` 与 CI 成功的 `38000aedd96e9119e289d59206aa27f114c4dfa3` 相同；新 main #85 的完整 tree 也与已包含的原 base `16771de1` 相同。按这份字节连续性复用已通过 CI，未把补历史后新排队的冗余 CI 冒充已通过；证据见 [PR #87 continuity](https://github.com/zts212653/clowder-ai-plugins/pull/87#issuecomment-6286505516)。合入后的 main 与候选源码树已比对一致。源码 v0.2.0 已落插件仓；npm/catalog、生产安装、Chrome 原生授权及真实供应商导出分别记录，本轮未替换生产插件、准备本机组件或触发生成。AC-2/5 与原 Task 继续开放。两个作者开发工位已通过原生 Git 移除并核验不在 worktree 列表；已合入源码、源分支和生成的安装归档保留，未处置其他 owner 工位。

2026-10-19（当地）建筑线沿原 Task 请求恢复已生成、未接收的账号资产。本轮只读实查：生产仍为原 v0.1.5 实例，建筑线按其使用请求恢复 enabled/running 后 lifecycle 为 7；实际 `tripo_status` 返回 `HELPER_DISCONNECTED`、auth unverified。当前本机 Native 注册指向 v0.1.5 已准备目录；主线已发一次 Chrome 加载/授权步骤，本线不覆盖注册、不替换生产包、不重复催该确认。

当前五工具只支持真实分享 URL，或已明确授权的 1–8 个模型页 UUID 及可用 preview 资源；`tripo_export_selected` 只复制已有本地文件，不请求供应商正式导出。现版和 v0.2.0 候选均没有全账号资产分页清单、生成记录或逐件实际扣分读取工具；不能把 /assets 页面、fixture 或旧 Alpha 记录当成已扫账号。本轮指定本地输入检索没有找到可立即回流的新建筑 GLB 或明确建筑分享 URL，未取得新文件；模型身份、余额/账单和账号完整性均保留未验证。具名恢复目录与机器可读缺口留在消费者项目，建筑总表、66 栋映射与 sharedscene 由主线维护，家里不复制项目资产数据。原 AC-2/5 与 Task 不关闭，不重抽已生成件、不调用另付费 API。

首轮分享链接审模已可实际使用：独立 `official.tripo-studio` v0.1.5 已经 Host 准入、启用并提供五个可调用工具；源码已通过非作者封板审查并合入 PR #5645，main merge SHA `1d953f6a10ed2a24452ae3ec64588473ac41cb39`。四个用户分享链接经已安装 v0.1.4 插件生成 16 张旋转截图；v0.1.5 另完成 C1 四图真实旅程。来源矩阵与新版实采分别标记版本；16 张比较图的来源/编号/图像 SHA-256 已回读核验。四轮 NSWorkspace 前台采样与原 Chrome 窗口/活动标签前后记录均保持；这是采样证据，不声称连续监控。此前 v0.1.3 三轮前台变化与 v0.1.0 错误取证保留为失败/不充分证据，没有改写成通过。

2026-10-16 operator 纠偏后，已按 F202 重新核定归属：Tripo 业务源码、独立构建与包发布属于 `clowder-ai-plugins`；Core 只消费版本化插件契约。Core PR #5658 已合入（main `d42b3917f12e789b2796493781208aa5ef7fceef`），移除本次 Tripo 业务源码、bundled 归档、专用 packer 与公开同步中的依赖准备/重建分支，只保留 `host-official-catalog.ts` 中 `official.tripo-studio` 的零 grant Host allow policy。它不提供发布坐标，也不凭空制造可安装版本。插件仓独立源码包经 #85/#87 已合入，新框架当前源码为 v0.2.0；具体 merge SHA、有效 CI 与本次 operator 授权见本节 2026-10-20 记录。旧 `e101cc541909031ac49a3fad896d43e1aa6c6f9b` 的检查仅属历史。尚未发布 npm 或进入官方 catalog；Core 去耦不等待该包发布。

此前 PR #5655（main `36c37aa935f62768c47cc13d8f5cf249d7a8c485`）解决冻结源码构建依赖，并生成 Core 归档 v0.1.6；这是历史修复，现已由两仓归属纠偏取代，不再继续加固 Core 打包链。当前 Host 已加载的实例仍为 v0.1.5，其实例、配置和已有产物保留；本次不卸载、升级或重启。公开同步与最终 CI 仍由 Astra / Task062 负责，不据源码迁移或局部验证声称发布完成。

模型/比较材料留在 `/home/user/projects/cat-planet/refs/review/tripo-plugin-dogfood/`（`index.html`、`manifest.json`、`host-receipt-v0.1.5.json`（矩阵保留 v0.1.4 真实来源） 及原始 provenance）。首轮分享页未取得可用 GLB，插件回执为 `not_exported`。母线程已通过人工下载取得 C1 并进入 Blender；该文件只核验、不复制，不能算插件正式导出完成。已登录 Chrome 通道尚未完成授权旅程，不是分享链接审模的前置。

## What

首轮独立插件沿用 Settings 插件管理与 MCP contribution，复用 F247 framing、配对记录和 socket lease。v0.1.5 显式授权单个 Studio 页面，只读已有候选/资源；不触发生成、贴图、充值、付费 API 或上传。后续获准的订阅工作流另设显式授权模式，不能沿用只读授权提交生成。所有路径都不复制 Cookie/profile；用户保留选型，项目数据留在消费者项目。

## 网页订阅扩展（F329 消费）

新增授权来源：母线程用户消息 `private-source-id`（使用网页订阅、扩展 F328，不调用另付费 API）与 `private-source-id`（先做Ragdoll、Maine Coon，形象确认后准备四视图及建模）。原 Task/owner 不变，素材线不接插件工程。

插件仓 PR [#87](https://github.com/zts212653/clowder-ai-plugins/pull/87) 原堆叠在 #85，现已转 main 合入 `fe8df82bae742dd3aef4bf2f9dc1c82837ade3fd`；最终 source HEAD `65a4992d3e1024cec3ab1f5ee2d9aec8be1ba007`，源码版本 v0.2.0，尚未 npm 发布或加载到生产。它新增六个 MCP 工具（共十一项），覆盖独立浏览器授权、生成参数预览、持久化单次提交与未知结果、供应商导出请求及校验后收文件。`tripo_workspace_status` 只能打开固定 Rig/Animate 页面并检查，**没有 AutoRig、应用 idle/walk 的写入口**。不能据这些工具名称宣称四足动作已经可用。

包级 26 项检查、实际 Chromium 中的固定 DOM/扩展工作流、双目录归档一致性、真实归档中的模块生命周期和空 consumer 十一工具调用通过。旧 `c11f21a97796d8b7b6b3b0b250afb7361d319148` 的 Typecheck + Conformance CI 于 2026-10-17 01:27 UTC 通过；2026-10-20 的 `38000aed` 远端 CI 已通过，最终无文件变化的历史连接提交通过完整 tree 一致性复用该证据。浏览器检查使用权限响应与供应商 DOM fixture，只证明相关契约，不等于登录订阅后的生成、导出或绑骨旅程。#85 默认涉及受保护文件；本次沿 You `private-source-id` 的 CI 通过即合入指示执行，两条 PR 均不再等待额外审查。两条源码 PR 已合入，尚未 npm 发布或更新 catalog；最新生产加载证据仍是 v0.1.5，不以本轮源码和归档验证替代。

实际浏览器前检：匿名 Studio Smart Mesh 页面可读取 Front/Left/Right/Back、生成参数与积分显示，写入被 `TRIPO_NOT_LOGGED_IN` 拒绝；匿名 Rig 页提供从 Assets 选择或上传既有 GLB 的入口，点上传会要求登录。没有向匿名会话上传家庭模型或参考图，没有提交生成或消耗积分。

素材线用户 `[thread-id]#private-source-id` 已手动生成、贴图并导出Ragdoll A/B 静态 GLB；随后 `private-source-id` 又交付 A 的真实绑定与异常 walk 导出。素材线已核到 40 关节、1 skin、约 2.6 秒四足 walk，但前爪过折、后腿间蒙皮牵连，变形质量未通过。素材线沿既有责任修整现有动作与权重，**不再等待插件 Rig 入口，不为当前 A 重复生成或 AutoRig**。这些人工供应商导出不是插件成果；非空骨架/动画也不等于动作验收。页面来源必须来自真实 Studio URL，不能用 GLB 内部 UUID 拼造作品链接。

10-17 的本机组件准备 v0.2.0 是历史实验步骤，当时 Chrome 仍未连接或授权。10-19 建筑线沿当前生产插件重新准备 v0.1.5；本轮实查 Native launcher 与稳定目录均为 v0.1.5。旧 v0.2.0 目录和归档仍在；#85/#87 本次已合入，但未 npm 发布或替换生产实例。当前应沿主线已发的 v0.1.5 原生确认操作，不叠加历史 v0.2.0 加载指引。Alpha 加载、源码 CI、当前实际工具与供应商真实生成/导出分别记录，不能互相代替。

## User Journey

已实测分享路径：Settings 安装/启用（本轮经同一 Host 的本地归档准入）→ 用户给准确分享 URL → `tripo_review_shared_model` 在新的匿名隐藏页面读取并保存比较材料 → You 选定。
可选已登录路径：猫经插件准备本机组件 → Chrome 加载扩展并在目标页面明确授权 → 猫取候选及可用预览 GLB → You 选定 → 校验后回到指定目录。该浏览器原生授权旅程及供应商正式导出仍未实测。
未授权、未连接、页面改版和资源不可用均诚实给出下一步；撤销立即阻止读取。

## Acceptance Criteria

- [x] AC-1：独立插件有完整安装包与真实可调用工具；installed/config/auth/intent/live 分开。
- [ ] AC-2：只读明确授权的 Studio 页面；不读 Cookie/profile，不接受任意脚本/URL/越界路径。
- [x] AC-3：四候选真实比较材料与来源编号一致；无真实模型不报面数或假多视图。
- [x] AC-4：前后活动窗口、标签、焦点证据证明无前台干扰。
- [ ] AC-5：已选模型回到指定目录，校验字节和来源。
- [x] AC-6：权限/契约/文件回流定向验证、一次聚焦独立审查后合入；真实旅程未完不宣称整项完成。

## 需求点 Checklist

| 需求 | AC | 验证 |
|---|---|---|
| 做个 Tripo 插件 | 1,2 | 完整安装包与授权调用 |
| 删除逐张旋转截图劳动 | 3,4 | 四候选比较与静默实测 |
| 主线是完成建模 | 5 | 真实文件回流 |
| 不过度 review、做完合入 | 6 | 定向检查与一个独立源 |

## Dependencies

Related：F247（有界本机桥接）、F202（插件管理）。Consumer：cat-planet 溪村建模；不挂 Google 专项 F327。

## Tips Contribution（F244）

已在现有 capability tip seed 贡献 Tripo 后台审模入口，指向 Settings 插件与真实授权说明。

## Implementation Evidence

Architecture cell: plugin adapter；Map delta: 新增独立 Tripo consumer；Why: 删除截图和搬运劳动。
Canonical source: `clowder-ai-plugins/packages/tripo-studio/`（业务源码、包内桥接适配、安装 manifest 与独立构建）；Core 的 `packages/api/src/domains/plugin/manager/builtin-contribution-supervisor.ts` 负责通用 MCP lifecycle，`host-official-catalog.ts` 只保留零 grant 准入策略。插件仓发布与 catalog 更新仍需各自真实回执；不把已有本地实例当成新版本已发布。

## 验证与剩余缺口

- 已合入的去耦修正移除 Core 的 Tripo 归档与 `pack-tripo-plugin.mjs --check` 标准 API 测试入口；独立源码包和发布验证归插件仓。已安装的 v0.1.5 保留其原交付版本和 SRI，未安装尚未发布的 v0.1.7。
- 去耦前的 64 项检查是首轮实现的历史证据，包括 Native 权限/版本、文件边界、源码漂移、空目录 consumer、Host 生命周期及包 staging；不把已删除的 Core 打包测试描述为当前入口。去耦修正另通过 44 项受影响检查，覆盖外部 catalog 归属、零 grant Host policy、现存安装实例管理、通用包 staging 与非 Tripo bundled 重建；API TypeScript、Biome 与 diff 检查通过。
- AC-2 的分享 URL/资源/来源守护与 Native 契约已验；实际 Chrome 授权、撤销及恢复旅程尚未完成，保留未勾。
- AC-4 当前只验匿名分享路径：四轮采样稳定；不为尚未授权的用户 Chrome 路径作承诺。
- AC-5 文件校验/不覆盖及已验证字节竞态已测，但插件没有取得供应商正式导出的 GLB，保留未勾。母线程人工取得的 C1 GLB 不计作此插件成果。
- SDK request cancellation 与 50 秒工作预算贯穿桥接、后台 Chrome/CDP 和整批下载；取消后清理不完整 batch 并释放 slot。真实 SDK 取消、批量预算、启动取消、Native 挂起与 CDP pending 均有 RED→GREEN 回归。
- 云端五轮采样已封板，gemini-argon 对最终 HEAD `aa87354483bc882c3ca05104ea912bf275f4807b` 完成有状态非作者终审并放行；typed fact `local-review:private-source-id:approved`。AC-6 已完成，PR #5645 已合入。Feature 仍为 in-progress，不关闭母线程 Task。

## 加载与交付边界

`main=landed:1d953f6a10ed2a24452ae3ec64588473ac41cb39`；独立插件 `live=loaded:0.1.5`，通过既有 Host 的本地不可变归档安装启用、真实调用及独立复核。归档 SRI 为 `sha512-z5iHswKOQj3qmGAz8ZtdjWjudGgc2/yZm7JfV9NmETlgt9+qY2uu8Fm7J5bjjFgq9a6oz1BA523+v85girr4Xw==`。本轮没有重启运行时；新的默认官方 catalog 注册随后续正常 Host 版本加载，不以本地已安装包代替 catalog 加载声明。

历史发布依赖修复 `main=landed:36c37aa935f62768c47cc13d8f5cf249d7a8c485` 曾生成 Core v0.1.6；该归档随 #5658 删除，不再作为当前发布方案。新包需要在 `clowder-ai-plugins` 独立审查、构建与发布后，才能以真实版本/完整性坐标进入 catalog；没有 npm 发布或新实例加载回执。F329 所需订阅网页上传、生成、正式导出及四足动作仍在准备，当前 v0.1.5 不支持这些动作，也未替用户消耗生成积分。
