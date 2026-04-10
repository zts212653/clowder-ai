# Clowder AI Brand & Design Guidelines

> "Hard Rails. Soft Power. Shared Mission."

## 1. 核心文案与术语 (Terminology)

- **Slogan**: Hard Rails. Soft Power. Shared Mission.
- **硬约束 / 铁律**: `Hard Rails` (不可越界的安全底线、系统边界)
- **软约束 / 引导**: `Soft Power` (愿景、文化、共创信条)
- **共同愿景**: `Shared Mission` (团队与 CVO 的共同目标)
- **禁忌词**: 严格禁止使用 `Soft Soul` 或其他变体，全仓必须统一口径。

## 2. 视觉意象：三棱镜 (The Prism Metaphor)

在 Landing Page Hero 视觉中，采用三棱镜折射光束的隐喻，语义映射必须严格对齐：

| 视觉元素 | 物理形态 | 架构语义 (Architecture) |
| :--- | :--- | :--- |
| **白光 (White Light)** | 入射强光 | **Vision** (铲屎官/CVO 的用户愿景与请求) |
| **棱镜 (The Prism)** | 坚固的几何体 | **Hard Rails** (平台层，规则与边界) |
| **色散光束 (Dispersed Colors)** | 蓝/绿/橙等多色光 | **多角色协作分工** (被框架过滤增强后的 Agent 团队) |
| **能量环线 (Orbital Rings)** | 缠绕棱镜的循环轨道 | **Memory & Audit** (记忆、审计与纠偏的闭环) |

## 3. 色彩规范与可访问性 (Colors & WCAG AA)

背景设定为深空灰 (`#0F172A`)。文字和关键元素需满足 WCAG AA 4.5:1 对比度要求。

### 基础色彩 (Base)
- **Background**: `#0F172A` (深空灰)
- **Primary Text**: `#F8FAFC` (白/浅灰，对比度 >15:1，完美通过 WCAG AAA)
- **Vision Light**: `#FFFFFF` (纯白，带发光滤镜)

### 角色色彩 (Role Tokens)
在深色背景下，必须使用亮度足够的主题色：
- **Opus Blue (Ragdoll)**: `#60A5FA` (Tailwind Blue 400)
- **Codex Green (Maine Coon)**: `#34D399` (Tailwind Emerald 400)
- **Gemini Amber (Siamese)**: `#FBBF24` (Tailwind Amber 400)
- **Bengal Orange (孟加拉猫)**: `#FB923C` (Tailwind Orange 400)

### 色盲安全替代方案 (Color-blindness Safe)
**规则**：不能仅靠颜色区分角色或信息状态。
**替代要求**：
- 结合形状纹理 (如虚线长短、点线段：`stroke-dasharray` 需具有可辨识性差异)
- 配合清晰的文本标签 (Explicit Text Labeling)
- （可选）配合专属图标 (如 ⚙️ 架构, 🛡️ 守卫, ✨ 创意)

## 4. 动效降级 (Motion & Accessibility)

为了保护对晕动敏感的用户，必须始终提供静态降级版本。所有动效定义必须包裹在 `@media (prefers-reduced-motion: no-preference)` 下。详见 `hero-prism-motion.md`。
