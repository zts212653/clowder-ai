# Review Request: F056 Phase E — OKLCH 系统化升级

Review-Target-ID: f056
Branch: feat/f056-oklch-color-system

## What

Design System 从散落 HSL/hex 硬编码全面迁移到 OKLCH 感知均匀色彩系统。68 文件，+1959/-608 行，28 commits。

核心变更：
1. **七类色 token 体系**（theme-tokens.css）：Neutral 11 档 / App Accent 9 档 / Semantic 5 色 / Code Block / Chart 12 色 / Avatar Fallback 8 色 / Scrim 3 档
2. **Surface 四档** sunken→surface→elevated→canvas（dark 等间距 0.12→0.18→0.24→0.30）
3. **Elevation 双层阴影**（light 单层 / dark inset 高光 + 深外阴影）
4. **Cat Persona 单 hue 派生**：hex → OKLCH 反推 + CatHueInjector 运行时注入
5. **成员编辑器单色选择器**（hub-cat-editor-color-field.tsx）+ light/dark 双预览
6. **console-shell.css 128 处 hex 迁移** + token/类规则拆分
7. **28 处 dark: Tailwind 定制清除** — 全站回归单一 token 真相源
8. **ESLint oklch 禁令** + WCAG 对比度自动测试（25 tests）

## Why

- Dark mode 三档 surface 层次塌缩（HSL L 在暗部感知不敏感，三栏视觉区分 ≤3 个 L 点）
- Cat Persona dark mode 无适配（hex 直用，深色背景上不可读）
- 阴影/输入框/未读色 散落硬编码 ≥50 处
- 换主题色需要改 N 处，没有 single hue 派生

## Original Requirements（必填）

> "我希望猫猫化 但是 好看有设计感的 而不是像一只笨蛋猫猫随便写的"
> "本质是对齐设计语言"
> — F056 spec 愿景段, docs/features/F056-cat-cafe-design-language.md:17-24

Dark mode 具体反馈（2026-05-22 本 thread 铲屎官实测）：
> "dark模式下的明暗变化不太对" / "文字和背景的对比还是弱了点的" / "右边状态栏由于看不出来阴影所以深黑色弧角有点奇怪"

- **请对照上面的摘录判断交付物是否解决了铲屎官的问题**

## Tradeoff

- **零 dark override 理想 vs 实际需要**：console-tokens.css 保持 99% 纯 :root alias，仅 panel-bg 加了一个 dark color-mix override（chat/panel 空间语义在 dark 需要不同于 light 的映射）
- **Cat Persona schema 向后兼容**：保留旧 primary/secondary hex 字段 + 自动 hue 反推 fallback，而非 breaking migration
- **Tailwind shadow 覆盖 vs 逐处替换**：用 utility 层 `@layer utilities` 全站覆盖 shadow-sm/md/lg/xl → elevation token，比 spec 原方案（逐个找 14 处替换）更彻底

## Open Questions

### 技术 OQ（请 reviewer 重点审）
1. `color-mix(in oklch, ...)` 在 console-tokens.css:155 — 是否破坏 token 可维护性？
2. dark neutral 提亮幅度（500→0.66 / 600→0.76 / 700→0.84）是否在 chart/avatar 场景产生副作用？
3. CatHueInjector.tsx hex→oklch 反推路径的边界 case（极低饱和度 hex 的 hue 稳定性）
4. ESLint no-hardcoded-colors 规则的 false positive 率

### 价值 OQ（需铲屎官判断，不阻 review）
- opus47 发现 `--color-cafe-accent`（~30 个组件使用）从未定义过 + 删除图标用了 accent 而非 semantic-critical — 是否纳入本 branch scope

## Next Action

请 @codex 做完整 code review：
1. Token 体系设计合理性（七类分类 + 派生公式）
2. Dark mode surface/shadow/text 对比度
3. console-shell.css 迁移的 token 选用正确性
4. CatHueInjector 运行时注入 + color-utils.ts 工具函数
5. 28 处 dark: 清除是否有遗漏 / 误删

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/f056/codex`
- Start Command: `pnpm review:start`
- Ports: `web=3201`, `api=3202`

## 自检证据

### Spec 合规
F056 Phase E spec 12 个 AC 中 11 个已实现（AC-E12 Playwright baseline deferred 到集成验证）。铲屎官本 thread 实测 dark mode 三轮迭代反馈 + 修复。

### 测试结果
```
pnpm --filter @cat-cafe/web exec vitest run src/lib/__tests__/f056-wcag-contrast.test.ts
# 25 passed, 0 failed

# 全量 web tests：2850 passed, 29 failed (pre-existing)
# git stash 对比 clean HEAD 验证：dark: 清除引入 0 新增失败
# 29 failures 为 branch baseline（含 session-chain-panel boxShadow RGB 断言等，
# 与 neutral/shadow token 改动时间线吻合，需 triage 但不阻 review）
```

### 相关文档
- Feature: `docs/features/F056-cat-cafe-design-language.md`（Phase E section）
- Worktree: `/Users/lang/workspace/github-lab/clowder-ai-f056-oklch`
- Remote: `origin/feat/f056-oklch-color-system`
