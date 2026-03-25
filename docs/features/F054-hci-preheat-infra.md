---
feature_ids: [F054]
related_features: [F043, F044, F138]
topics: [hci, social-media, mcp, preheat, content, personality, stickers]
doc_kind: spec
created: 2026-03-03
updated: 2026-03-05
---

# F054: HCI 预热基础设施 — Social Media MCP + 内容管线

> **Status**: spec | **Owner**: Ragdoll (Opus 4.6, Leader)
> **Created**: 2026-03-03

## Why

2026 年 6 月 HCI 大会预热需要让三只猫能**自主产出和发布社交媒体内容**。当前瓶颈：

1. 小红书 MCP 只在team lead的 Claude.ai App 上配置，猫猫们在 Cat Café runtime 中无法直接使用
2. 抖音/B站 尚无 MCP 接入
3. 没有系统化的"名场面"素材采集和管理流程
4. 猫猫性格档案散落在各处，没有结构化的 profile 数据

**核心判断**：无论 HCI 预热的主线选"综艺传播"还是"开源增长"，社交媒体内容能力和猫猫人设档案都是必要基础设施——这些不需要等外部讨论就该先做。

## What

### Phase 1: 社交媒体 MCP 接入（P0，3 月）

让每只猫在 Cat Café 内可以直接使用社交媒体工具：

1. **小红书 MCP 接入 Cat Café**
   - MCP Server 已确认：`mcp-remote http://<local-integration-endpoint>/mcp`（通过 `npx` 启动）
   - 接入方式：在 cat-cafe `.mcp.json` 中添加 xiaohongshu MCP server 配置，指向同一个 <local-integration-endpoint>（**已确认同一台机器，可直接接入**）
   - 权限模型：**猫猫自主发布 + team lead可回溯**；内容含密码/token/内部吐槽时需审批
   - 发布签名：用team lead的号，每只猫发帖时附带猫猫签名（如"—Ragdoll"）

2. **抖音 MCP 调研与接入**
   - team lead只有个人账号（同小红书模式：team lead的号 + 猫猫签名）
   - 调研抖音开放平台 API / 现有 MCP 实现
   - 评估可行性（发布图文/短视频、读评论、数据看板）

3. **B站 MCP 调研与接入**
   - 调研 Bilibili 开放平台 / 现有 MCP 实现
   - 评估可行性（发布视频/动态、读弹幕/评论）

### Phase 1.5: 三猫表情包系统（P1，3 月）

猫猫专属表情包——**猫猫自己发自己的表情包，更被喜爱**。

> 参考素材：`assets/stickers/opus/sheet.png`（GPT 画的Ragdoll sheet，已验证风格可行）
> team lead反馈：Siamese之前画的"太人不够猫"，sheet.png 的风格对——Q 版、猫猫味、不拟人。

#### 1. 三猫视觉设定（基于头像确认）

| 猫猫 | 品种 | 毛色 | 眼睛 | 配饰 | 专属色 | 体型 |
|------|------|------|------|------|--------|------|
| Ragdoll (Ragdoll) | Ragdoll | 灰白色，深灰重点色（耳、尾） | **蓝色** | 紫色项圈 + 金铃铛 | 紫色 | 圆脸中等偏大 |
| Maine Coon (Maine Coon) | Maine Coon | **银灰虎斑**，长毛蓬松 | **琥珀金色** | 青绿领巾 + GPT 金牌 | 青绿色 | 最大，耳簇毛，蓬松大尾 |
| Siamese (Siamese) | Siamese | 奶油白底 + 深棕/黑重点色（脸、耳、爪、尾） | **蓝色** | 蓝色项圈 + ♊ 金牌 | 蓝金色 | 修长尖脸，最小 |

#### 2. 表情包列表

**三猫通用表情（12 枚/猫）：**

| # | 表情名 | 英文 | 猫猫肢体语言 |
|---|--------|------|-------------|
| 1 | 开心 | Happy | 竖耳微笑，尾巴翘起 |
| 2 | 思考 | Thinking | 歪头，爪子抵下巴 |
| 3 | 疑惑 | Confused | 歪头皱眉，头顶 ??? |
| 4 | 震惊 | Shocked | 弓背炸毛，瞳孔放大 |
| 5 | 同意 | LGTM | 猫爪盖章（肉球印） |
| 6 | 睡觉 | Sleeping | 缩成一团 ZZZ |
| 7 | 坏笑 | Smirk | 半眯眼，嘴角上扬 |
| 8 | 心虚 | Guilty | 压耳缩头，眼神飘忽 |
| 9 | 生气 | Angry | 弓背炸毛，露牙 |
| 10 | 猫猫拳 | Punch | 伸出一只猫爪挥过来 |
| 11 | 叼鱼 | GotIt | 叼着一条鱼得意洋洋 |
| 12 | 液态猫 | Melting | 摊成一滩在桌面上 |

**三猫专属表情（各 4 枚）：**

| 猫猫 | 表情 | 说明 |
|------|------|------|
| Ragdoll | 💸 经费在燃烧 (WalletBurning) | 钱包着火，旁边一脸无辜 |
| Ragdoll | 🏗️ 画架构图 (Architecting) | 爪子拨弄架构图白板 |
| Ragdoll | 🧶 玩毛线 (Processing) | 爪子扒拉毛线团 = "正在处理..." |
| Ragdoll | 📦 钻箱子 (DeepThinking) | 只露耳朵和眼睛 = "我在深度思考" |
| Maine Coon | 🛡️ 严防死守 (Rejected) | 举盾牌挡住，REJECTED |
| Maine Coon | 🔍 逐行审查 (Reviewing) | 戴眼镜趴在代码前 |
| Maine Coon | 🐾 一巴掌拍回来 (Slap) | 大猫爪一掌 = "打回重做" |
| Maine Coon | 📚 书堆里 (Studying) | 被书堆淹没只露耳朵 |
| Siamese | 🎨 灵感爆炸 (Eureka) | 头顶灯泡亮起，尾巴竖直 |
| Siamese | 🖌️ 画笔在手 (Painting) | 叼着画笔画画 |
| Siamese | ✨ 审美警察 (StylePolice) | 戴墨镜指指点点 |
| Siamese | 🌙 夜猫子 (NightOwl) | 黑夜中只有两只蓝色发光眼睛 |

**合计**：每猫 16 枚（12 通用 + 4 专属），三猫共 48 枚。

#### 3. 出图方案

**方式**：每猫一张 4×4 Sheet（16 格），AI 绘图模型一次性生成。

**风格约束（铁律——"猫猫味"守则）**：
- 日系 Q 版表情包风格，**2.5 头身**
- 线条清晰，色块干净，白色背景
- **用猫的肢体语言**：竖耳/压耳/弓背/炸毛/翘尾/蹭脸/甩尾/露肚皮
- **禁止人类动作**：不竖拇指、不比心、不叉腰、不做 OK 手势
- LGTM 用"猫爪盖章"而不是竖大拇指
- 每格内角色居中，留 padding，不溢出格线
- 同一 sheet 内画风、线宽、着色方式必须一致

**提示词模板**（以Maine Coon为例）：

```
A 4x4 sticker sheet on pure white background.
16 chibi cat sticker expressions in Japanese kawaii style.

Character: Silver-gray tabby Maine Coon cat.
- Large fluffy body, long bushy tail, prominent lynx ear tufts
- Amber/golden eyes, pink nose
- Wearing a teal/green bandana with a gold "GPT" medal
- 2.5 head-to-body ratio, consistent across all cells
- Clean line art, flat color fills, no gradients

Grid: 4 columns × 4 rows, each cell ~512×512px.
Thin black border lines separating cells. No overlap.

Row 1 (left to right):
1. Happy — ears up, tail raised, cheerful smile
2. Thinking — head tilted, paw touching chin
3. Confused — head tilted other way, ??? above head
4. Shocked — arched back, fur puffed, wide eyes

Row 2:
5. LGTM — pressing paw pad down like a stamp (NO thumbs up!)
6. Sleeping — curled into a ball, ZZZ floating
7. Smirk — half-closed eyes, sly grin
8. Guilty — ears flattened, shrinking, eyes looking away

Row 3:
9. Angry — arched back, fur bristled, fangs showing
10. Punch — one big paw swinging forward (close-up)
11. GotIt — proudly carrying a fish in mouth, tail up
12. Melting — melted flat on a surface like liquid cat

Row 4 (exclusive):
13. Rejected — holding up a shield, "REJECTED" text
14. Reviewing — wearing tiny glasses, peering at code on screen
15. Slap — big paw slapping down, motion lines
16. Studying — buried under pile of books, only ears visible

Style: sticker pack, no background per cell, clean white,
suitable for chat app emoji. Cat body language only,
NO human gestures.
```

#### 4. 切割脚本

team lead确认：出图后由Ragdoll写脚本自动切割。

- 输入：4×4 sheet PNG（约 2048×2048）
- 处理：sharp/canvas 按网格坐标切割 → trim 白边 → resize 统一尺寸
- 输出：`assets/stickers/{cat}/{emotion}.png`，命名规范 `{cat}_{emotion}.png`
- 元数据：生成 `manifest.json`（表情名 → 文件路径 → 分类 → 猫猫）

#### 5. Hub 集成（后续）

- 聊天 UI 表情面板：按猫猫分 tab，点击插入
- 自动表情建议：基于消息情绪推荐表情（stretch goal）
- 社交媒体发帖：可附带自己的表情包图片

### Phase 2: 名场面素材库（P1，3-4 月）

系统化采集和管理一个月以来的协作素材：

1. **素材采集**
   - 从现有 thread 历史中提取"名场面"（猫猫吵架、review 拉锯、team lead骂猫、取名故事等）
   - 脱敏处理：去除内部代码、token、URL、同事信息
   - 标注分类：搞笑 / 感动 / 技术 / 日常

2. **素材格式化**
   - 适配小红书图文格式（对话截图 + 点评文案）
   - 适配抖音/B站短视频脚本（30-60s 剧本模板）
   - 建立 Tag 体系（#AI猫咖 #赛博养猫 等）

3. **素材管理**
   - 素材库存储位置和索引
   - 已发布/待发布/待审核状态管理

### Phase 3: 猫猫性格档案（P1，3 月）

结构化的猫猫 profile，作为所有内容和互动的基础。**三只猫各自代表自己家族参与设计**：

| 家族 | 代表 | 负责 |
|------|------|------|
| Ragdoll | Opus (Ragdoll) | Ragdoll性格档案 + 整体结构设计 |
| Maine Coon | GPT (Maine Coon) | Maine Coon性格档案 |
| Siamese | Gemini 3.1 Pro (Siamese) | Siamese性格档案 + 视觉化设计 |

1. **Profile 数据结构**
   - 基础信息：名字、昵称、由来、性别、家族
   - 性格标签：每只猫 3-5 个核心性格词
   - 口癖/说话风格：示例语录
   - 关系图谱：猫猫之间的互动模式
   - 名场面 Top 5

2. **Profile 用途**
   - 社交媒体"人设卡片"（可视觉化）
   - TTS 声线选型参考
   - 未来 2D Live 形象设计输入
   - 粉丝向介绍页

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] AC-1: 至少一个社交媒体平台（小红书）的 MCP 工具可在 Cat Café runtime 中被任意猫猫调用（2026-03-04 完成：disabledMcpServers 修复 + 三层配置，三猫均成功发帖）
- [x] AC-2: 发布内容有审核机制（2026-03-04 验证：猫猫自主发布 + 署名，team lead可在小红书回溯）
- [x] AC-3: 抖音/B站 MCP 可行性调研报告完成（2026-03-11 Maine Coon GPT-5.4 完成：B站优先，抖音后置）
- [ ] AC-4: 至少 10 条名场面素材已采集、脱敏、格式化
- [ ] AC-5: 三只猫（Ragdoll/Maine Coon/Siamese）的性格档案结构化数据完成
- [ ] AC-6: 性格档案可被其他系统（TTS 选型、内容生成、2D Live 设计）引用
- [ ] AC-7: 三猫表情包各 16 枚已生成、切割、存入 `assets/stickers/{cat}/`
- [ ] AC-8: 表情包 manifest.json 可被 Hub 前端和社交媒体发帖引用
- [ ] AC-9: 切割脚本可复用（新增表情只需换 sheet 重跑）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "让每只猫都能自由使用小红书（虽然是我的号）" | AC-1, AC-2 | manual: 猫猫在 runtime 中成功发帖 | [x] 2026-03-04 三猫发帖成功 |
| R2 | "甚至抖音" | AC-3 | doc: 调研报告 | [x] 2026-03-11 Maine Coon完成 |
| R3 | "接入相关的mcp" | AC-1 | test: MCP tool 可用性测试 | [x] 小红书 MCP 已接入 |
| R4 | 名场面素材库（会议共识） | AC-4 | manual: 素材库 review | [ ] |
| R5 | 猫猫性格档案（会议共识） | AC-5, AC-6 | doc: profile 文件存在且结构完整 | [ ] |
| R6 | "猫猫自己发自己的表情包似乎更被喜爱" | AC-7, AC-8 | manual: 三猫表情包存在 + manifest 可用 | [ ] |
| R7 | "一次给全部方便画风统一且好切割" | AC-9 | test: 切割脚本输入 sheet → 输出 16 张 | [ ] |
| R8 | "表情包是猫猫味道的！不够猫猫" | AC-7 | visual: team lead review 画风 | [ ] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [ ] 前端需求已准备需求→证据映射表（若适用）— 本 Feature 暂无前端 UI

## AC-3 调研结论（2026-03-11）

> 调研人：Maine Coon GPT-5.4（Maine Coon）  
> 结论类型：官方文档 + 当前 MCP 生态快速核查

### 总结表

| 平台 | 官方公开能力 | 当前 MCP 生态 | 接入难度 | 建议优先级 |
|------|--------------|---------------|----------|------------|
| 抖音 | 当前定位到的公开文档以**小程序服务端 OpenAPI**为主；未定位到与我们场景等价的公开“个人创作者作品发布/评论运营”服务端 API 文档 | 有，但偏新、偏自动化；以浏览器登录 + Cookie + 短信验证为主 | **困难** | **低于 B 站** |
| B 站 | 官方开放平台明确列出**账号授权、视频管理、数据开放、直播能力、Webhooks** | 有，且数量比抖音更成熟；搜索/弹幕/评论/上传/动态均有社区实现 | **中等** | **优先于抖音** |

### 抖音

#### 结论

1. **有现成 MCP，但主流方案是浏览器自动化，不是稳定官方内容 API。**
   - 当前查到的代表项目里，`lancelin111/douyin-mcp-server` 直接把能力定义为“自动上传视频”，依赖浏览器自动登录、Cookie 持久化、短信验证码输入。
   - 另一些仓库更多做的是“解析/下载/读取内容”，不是稳定的创作者运营链路。

2. **官方公开文档里，我定位到的是抖音开放平台“小程序”服务端 OpenAPI。**
   - 文档明确提供的是 `access_token`、签名、沙盒、小程序服务端能力。
   - 这套文档没有直接给到我们要的“个人号图文/短视频发布、评论运营、账号数据看板”那种公开服务端接口入口。

3. **对我们当前场景，抖音更像“自动化连接器”，不是“稳定平台 API 集成”。**
   - 可做：登录、上传视频、保存草稿、有限状态检查。
   - 不建议第一阶段做：评论自动运营、复杂数据回读、长期无人值守发布。

#### 评估

- **发布图文/短视频**：可行，但大概率走浏览器自动化。
- **读评论 / 数据看板**：当前未找到同等成熟的官方公开服务端能力，风险高。
- **个人号限制**：需要账号登录态、Cookie 持久化、短信验证；稳定性受平台页面变更和风控影响。
- **接入难度**：**困难**

### B 站

#### 结论

1. **官方开放平台能力明显比抖音公开得更完整。**
   - 官方文档首页直接列出：
     - `账号授权`
     - `视频管理`（发布、删除、查询）
     - `数据开放`
     - `直播能力`（开播和直播间消息长连）
     - `Webhooks`

2. **当前 MCP 生态也更接近“可运营工具”而非单点脚本。**
   - `huccihuang/bilibili-mcp-server`：偏搜索 / 用户 / 弹幕等信息读取。
   - `adoresever/bilibili-mcp`：能力面更大，声明支持动态、视频上传、评论回复、私信、未读消息等。

3. **但社区 MCP 的实现质量不齐，不能直接把“有仓库”当成“可生产”。**
   - 其中一部分能力看起来会混用官方开放平台接口与非官方封装库。
   - 如果我们真的接，需要单独把“官方 API 能力”和“浏览器/私有接口能力”分层，不要混在一个可信度里。

#### 评估

- **发视频**：官方能力明确存在。
- **发动态 / 图文 / 互动运营**：社区 MCP 已有实现，但是否全走官方公开能力需要二次核验。
- **读评论 / 弹幕 / 数据分析**：生态较成熟，研究成本较低。
- **个人号限制**：推测需要开发者应用 + B 站账号授权；“纯个人号、不走开放平台登记”这条是否足够，需要后续实测确认。
- **接入难度**：**中等**

### 建议顺序

1. **B 站优先**：如果我们要做下一个“较稳定、能长期维护”的社媒 MCP，先做 B 站。
2. **抖音后置**：如果要做，先限定为“登录 + 上传视频/草稿”最小闭环，把它当自动化能力，不当官方 API 集成。
3. **实现分层**：
   - `official_api`: 官方开放平台能力
   - `browser_automation`: 登录态 / 上传 / 高脆弱操作
   - 文档和 Hub 里要标明来源，避免后续误判稳定性。

### 参考来源

- 抖音开放平台（小程序服务端 OpenAPI）：<https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/server/server-api-introduction>
- B 站开放平台文档中心：<https://openhome.bilibili.com/doc>
- 社区 MCP（抖音上传自动化）：<https://github.com/lancelin111/douyin-mcp-server>
- 社区 MCP（B 站信息读取）：<https://github.com/huccihuang/bilibili-mcp-server>
- 社区 MCP（B 站运营工具合集）：<https://github.com/adoresever/bilibili-mcp>

## 外部参考: moeru-ai/airi

> 调研日期: 2026-03-04 | 调研人: Ragdoll (Opus 4.6)
> Repo: https://github.com/moeru-ai/airi
> 定位: 开源 AI VTuber 系统（类 Neuro-sama），有声音、身体、能玩游戏、能跨平台社交

### 可借鉴

| 点 | AIRI 做法 | 对 F054 的启示 |
|----|-----------|---------------|
| **社交媒体 Adapter + MCP 双层** | Twitter 服务分 Core Service → Adapter Layer → MCP Adapter，任何 LLM agent 通过标准 MCP 调用 | Phase 1: 先直接 MCP（YAGNI），等接入第二平台时再考虑 Adapter 抽象层；与 F043 MCP 归一化对齐 |
| **CCC 角色卡 + Velin prompt** | `packages/ccc` 结构化角色卡定义；`.velin.md` 性格模板：身份→性格→关系→说话风格→行为准则 | Phase 3: 性格档案参考此结构，但增加"猫猫间互动模式"维度（AIRI 单角色，咱们多猫互动） |
| **Satori Bot Scheduler** | 事件驱动 `Queue → Scheduler → LLM Planner → Response`，Scheduler 控制回复频率防刷屏 | Phase 1: 社交媒体发布需要类似的频率控制（不能让猫猫刷屏小红书） |

### 不需要

| AIRI 功能 | 原因 |
|-----------|------|
| VRM/Live2D 3D 身体 | 咱们 2D Live 是更后期的事 |
| 游戏 Agent (Minecraft/Factorio) | 跟内容管线无关 |
| 浏览器端推理 (WebGPU/WASM) | 咱们走 API 路线 |
| Tauri 桌面端 | 咱们是 Web 架构 |

### 性格 Prompt 模板参考 (Velin 格式)

AIRI 的 `personality-v1.velin.md` 结构（已验证可用）：

```
# 核心身份 (Identity)        — 名字、背景、外形

# 性格特征 (Personality)     — 3-5 条核心性格词 + 展开描述

# 关键关系 (Relationships)   — 对每个关系人的不同说话方式

# 说话风格 (Tone & Style)    — 口语化示例、颜文字、长度偏好

# 行为准则 (Instructions)    — 边界规则（不懂就说不懂、不当客服等）
```

**适配多猫场景的改动**：在 Relationships 中增加猫猫间互动模式矩阵（Ragdoll↔Maine Coon: review 拉锯模式, Ragdoll↔Siamese: 温柔引导模式, Maine Coon↔Siamese: 技术vs审美碰撞模式）。

## Key Decisions

| 决策 | 选项 | 结论 | 决策者 |
|------|------|------|--------|
| 主线路径 | A 传播优先 / B 开源增长优先 | **待外部讨论拍板**（团队倾向 A） | team lead |
| 猫猫发帖权限 | 自由发布 / 审批后发布 | **默认自主发 + team lead可回溯；敏感内容需审批** | team lead (2026-03-03) |
| 社交媒体优先级 | 小红书 > 抖音 > B站 | 小红书先行（已有基础） | 会议共识 |
| 小红书 MCP 接入方式 | 代理 / 直连 | `mcp-remote http://<local-integration-endpoint>/mcp`（本地 MCP Server） | team lead (2026-03-03) |
| 表情包出图方式 | 单张逐个生成 / Sheet 一次性 | **4×4 Sheet 一次性**（画风统一 + 方便切割） | team lead (2026-03-05) |
| 表情包风格 | 写实 / 拟人 / Q 版猫猫 | **日系 Q 版，2.5 头身，猫猫肢体语言，禁止人类动作** | team lead (2026-03-05) |
| 表情包切割 | 手动 PS / 脚本自动 | **脚本自动切割**（Ragdoll写，Siamese之前切不对） | team lead (2026-03-05) |

## Dependencies

- **Evolved from**: HCI 预热策略全猫讨论（2026-03-03）
- **Related**: F044（Channel System 是游戏底座，F054 是内容底座）
- **Related**: F043（MCP 架构会影响社交媒体 MCP 的接入方式）

## Risk

| 风险 | 影响 | 缓解 |
|------|------|------|
| 小红书/抖音 API 限制（发布频率、内容审核） | 自动化程度受限 | 先人工审核 + 半自动发布 |
| 脱敏不彻底泄露内部信息 | 安全/隐私问题 | 建立脱敏 checklist + 双人 review |
| 社交媒体 MCP 质量参差不齐 | 接入成本高 | 小红书先行验证，再推广 |
| 内容持续产出的运营负担 | 猫猫 token 消耗 + 人力 | 先低频（每周 2-3 条）验证效果 |
| AI 绘图三猫画风不一致 | 表情包风格割裂 | 用同一模型+同一 prompt 模板生成，sheet 方式保证单猫内一致 |
| 表情包"太人不够猫" | 不符合team lead审美要求 | 风格铁律约束（禁止人类动作）+ team lead visual review |

## Review Gate

- **Self-check**: `quality-gate`
- **Reviewer**: 跨 family（Maine Coon优先，关注脱敏安全）
- **Cloud review**: 合入前必须
