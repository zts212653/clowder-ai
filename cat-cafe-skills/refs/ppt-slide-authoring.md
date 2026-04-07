# PPT Slide Authoring — HTML 制作规范

> ppt-forge 场景 C 的执行细节。
> 触发：大纲确认 + 风格确认后，开始画 slide。

## 核心原则

**画 HTML 是创作，不是填表。每页 slide 是一个独立的信息设计作品。**

- 目标：让受众看完这页后产生你预设的认知变化
- 手段：混合布局、真实素材、多层级信息架构
- 约束：archetype + viewing mode 决定一切排版参数

## 开工前确认（从主 skill 继承）

画之前必须已经有：

| 参数 | 来源 | 示例 |
|------|------|------|
| archetype | 铲屎官/内容规划 | 架构总览 / 数据洞察 / 方案对比 |
| viewing mode | 铲屎官确认 | presentation（大屏）/ document（阅读） |
| 品牌 | 主 skill 开局 | 华为 / Apple / 阿里 |
| 本页目的 | 一句话 | "证明对等判断优于中央编排" |
| 证据源 | 明确列出 | `03-architecture.md` + git log |

**没有这 5 项 = 不许动手画。**

## 制作流程

```
1. 读证据源，提取核心数据和论点
2. 选 archetype 模板（见 ppt-density-playbook.md 页面构成模板）
3. 画 HTML（1280×720 fixed viewport）
4. 跑 Pre-flight Checklist（见下方）
5. 截图自检（必须自己看一遍渲染结果）
6. 通过 → 交活；不通过 → 改到通过
```

## Pre-flight Checklist ★

**画完每页 HTML 后，交活前必须逐条自检。不满足 = 不许交活。**

### 密度检查

- [ ] 用了 **≥ 3 种**填充手段？（KPI/截图/表格/SmartArt/总结条/色块/图标/多级字号）
- [ ] 有**真实截图或图片**？（纯文字页 = 必须说明理由）
- [ ] 有 **SmartArt/流程图**？（纯表格+文字 = 必须说明理由）
- [ ] whitespace < 35%？（用 grid-sampling 或 density-analyzer 测量）

### 自洽检查

- [ ] viewing mode 和字号体系匹配？
  - presentation: 正文 ≥ 14px，标题 ≥ 22px
  - document: 正文 8-12px，标题 16-20px（华为密度页）
- [ ] archetype 没漂移？（开工时说"架构总览"，交活时还是"架构总览"）
- [ ] 所有数字可追溯到声明的证据源？（不可追溯 = 扩展源列表或改定性表达）

### 愿景检查

- [ ] **这页让受众看完会觉得 ___？**（写出来，如果写不出 = 目的不清）
- [ ] 和上一版对比，信息密度和说服力没有下降？（如果改过 = 必须对拍）

### 技术检查

- [ ] 0 overflow？（`el.scrollHeight > el.clientHeight + 2` 全 slide 扫描）
- [ ] 图片路径在 HTTP server 环境下能正常加载？
- [ ] 渲染截图已保存？（feedback: 自检必须截图看一遍再交活）

## 素材使用

### 图片/截图

- **优先用真实产出**（教程素材 `docs/stories/*/tutorial/assets/`、产品截图）
- 一张截图 = 几十行文字的信息量，是密度性价比最高的手段
- 图片太大时用 `max-height` 限制，不裁剪内容
- 图片路径注意 HTTP server 根目录（不要用跳出 server root 的相对路径）
- CSS 模板见 `ppt-density-playbook.md` "截图 + Callout 标注 CSS 模式"

### SmartArt/流程图

- 用 CSS flexbox + `▶` 字符实现横向箭头链
- 交替色增加视觉区分
- CSS 模板见 `ppt-density-playbook.md` "SmartArt/流程图 HTML 模板"

## 愿景优先原则（Review 应对）

收到 reviewer 的修改建议时：

1. 正常走 VERIFY 三道门（Spec Gate / Mechanism Gate / Feature Gate）
2. **额外加一道愿景门**：改完后，这页的核心价值（信息密度、说服力、视觉冲击力）还在吗？
3. 如果改完会降低核心价值 → **push back**，提出替代方案（如：扩展证据源 而非 删数据）
4. **独立思考 > 迎合 review** — 我们架构的核心就是每只猫独立判断

> 教训：D5 中Maine Coon说"0 生产事故不在单一证据源" → Ragdoll直接删了有冲击力的 KPI。
> 正确做法：push back 扩展证据源列表，保留有价值的数据。

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 没确认 5 项参数就动手 | 画完发现方向不对 | 开工前强制确认 |
| 只用文字+表格 | 密度低、视觉单调 | 至少 3 种填充手段 |
| 纯 CSS 画架构图 | 制作慢、效果差 | 优先用真实截图 |
| 图片路径跳出 server root | 图片加载失败 | 复制到 examples/ 或用绝对 URL |
| 改了不对拍 | 信息腰斩无人察觉 | 改后必须和上一版并排对比 |
| 为迎合 review 删有价值数据 | PPT 说服力下降 | push back + 替代方案 |
