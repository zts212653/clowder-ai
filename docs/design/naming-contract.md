# Naming Contract — Cat Café / Clowder AI

> 一页纸定死命名边界。所有公开文档、sync 脚本、UI 文案、品牌资产的命名决策，都以这一页为准。

**决策时间**: 2026-03-18  
**参与猫猫**: Ragdoll(Opus)、Maine Coon(GPT-5.4)、金渐层(OpenCode)  
**铲屎官拍板**: You  
**依据**: F059 开源计划 §命名与品牌、三猫共识讨论

---

## 1. 核心原则

**两层各一个名字，边界清楚。** 真正会让人迷惑的不是双名，而是同一层里混着叫。

## 2. 命名边界表

| 层面 | 用什么名字 | 例子 | 负责方 |
|------|-----------|------|--------|
| **内部代码** | `cat-cafe` | `@cat-cafe/api`, `cat-cafe-skills/`, `cat-cafe:session:*` | 开发者，**不改** |
| **内部日常** | Cat Café / 猫咖 | Linear 项目名、团队沟通、内部文档 | 团队惯例，**不改** |
| **对外品牌** | Clowder AI | GitHub org/repo README、官网标题、社交媒体 | sync 脚本 + 公开模板 |
| **桥接语** | Clowder AI, from Cat Café | README Origin Story、About 页面 | 文档模板 |
| **UI 标题** | 公开版 → Clowder AI | `<title>`, header `<h1>`, PWA title | sync transform |
| **UI 标题** | 内部版 → Cat Cafe | 保持现状 | **不改** |
| **Logo 文件** | 源仓 `cat-cafe-logo-*` → 开源仓 `clowder-ai-logo-*` | sync script rename | sync transform |
| **npm 包名** | `@cat-cafe/*` | `@cat-cafe/api`, `@cat-cafe/shared` | **不改** |
| **MCP 工具前缀** | `cat_cafe_*` | `cat_cafe_post_message` | **不改** |
| **Redis key** | `cat-cafe:*` | `cat-cafe:session:*`, `cat-cafe:thread:*` | **不改** |
| **localStorage** | `cat-cafe-*` | `cat-cafe-userId` | **不改** |
| **目录名** | `cat-cafe`, `cat-cafe-runtime`, `cat-cafe-skills` | worktree 路径 | **不改** |
| **workspace label** | 已知内部目录名（cat-cafe 等）映射为品牌名，其它项目路径保持原样 | Header thread indicator | 代码改进 |

## 3. 同步脚本职责

`sync-to-opensource.sh` + `_sanitize-rules.pl` 负责出口处的"翻译"：

### 已有的 transforms
- README.md → 替换为 `README.md`（已含 Clowder AI 品牌）
- CONTRIBUTING.md, SETUP.md → 替换为开源版
- CLAUDE.md, AGENTS.md, GEMINI.md → 生成通用版
- cat-config.json → 脱敏版
- 端口映射 3003/3004 → 3003/3004
- Redis 端口：不转换，开源仓也用 6399/6398
- 个人信息脱敏（You → Owner 等）
- 内部路径/猫名通用化（docs 层）

### 本次新增的 transforms
- `layout.tsx`: title "Cat Cafe" → "Clowder AI", description 通用化
- `ChatContainerHeader.tsx`: `<h1>` "Cat Cafe" → "Clowder AI", 默认描述通用化
- `useChatCommands.ts`: /config 显示文案 "Cat Cafe" → "Clowder AI"
- Logo 文件 rename: `cat-cafe-logo-*` → `clowder-ai-logo-*`
- `_sanitize-rules.pl`: UI 文案层面的 "Cat Cafe" → "Clowder AI"（仅 .ts/.tsx 里的用户可见字符串，不碰标识符）

## 4. 不该动的（红线）

以下是**系统协议名**，不是品牌文案。动了就是故障：

| 不能改的 | 原因 |
|---------|------|
| `@cat-cafe/*` npm scope | 所有 import 路径断裂 |
| `cat_cafe_*` MCP 工具名 | 所有猫的 prompt/config 全炸 |
| `cat-cafe:*` Redis key | 线上数据 orphan |
| `cat-cafe-runtime/` | 绝对路径断裂 |
| `cat-cafe-userId` localStorage | 用户 session 丢失 |
| `mcp_servers.cat-cafe` | Codex 集成断线 |
| commit 历史里的引用 | 历史不可改，改了新旧混杂更乱 |

## 5. workspace label 改进

Maine Coon指出：`ChatContainerHeader.tsx` 里的 thread indicator 直接从 `projectPath` 取最后一段目录名显示。这不是品牌文案，是运行时路径泄露。

**改进方案**：
1. 新增环境变量 `NEXT_PUBLIC_BRAND_NAME`（开源版 .env.example 设为 "Clowder AI"）
2. `ChatContainerHeader.tsx` 匹配已知内部 basename（cat-cafe、cat-cafe-runtime、clowder-ai）时显示品牌名，其它项目路径保持真实 basename
3. 内部版（无 env var）显示真实目录名（如 `cat-cafe`），开源版自动显示 "Clowder AI"，多 workspace 场景其它项目路径保持原样

## 6. 品牌视觉

品牌视觉规范见 [`docs/design/clowder-ai-brand.md`](./clowder-ai-brand.md)。

- Slogan: Hard Rails. Soft Power. Shared Mission.
- 禁忌: 不用 "Soft Soul"
- 色彩: 深空灰底 + 角色色（Opus Blue / Codex Green / Gemini Amber）

---

*"家叫猫咖，品牌叫 Clowder，同步脚本做翻译，不搞大迁移。"*
