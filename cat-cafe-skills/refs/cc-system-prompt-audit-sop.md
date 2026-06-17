# CC / Codex System Prompt Audit SOP（F203 Phase E）

> 真相源。猫家共享。来源：F203 Phase E（operator 2026-05-15："每个 claude code
> 大版本更新我们需要拆一次 cc 的系统提示词，比如他添加了新的功能性系统提示词
> 我们得补"）。工具：`scripts/audit-claude-code-system-prompt.mjs`。

## 为什么需要这个 SOP

F203 把 L0 切到 native system role（`--system-prompt-file` / Codex
`-c developer_instructions`）= **替换式**：会替换掉 Claude Code / Codex CLI
自带的系统提示词。其中"客观性/功能性"段（工具发现、并行调用、destructive
safety、压缩感知、simple_system_prompt 机制、agent 模式）必须在
`assets/system-prompts/system-prompt-l0.md` §2 **carry-over**，否则猫丢能力。

CLI 每次版本升级可能**新增功能性指令**——不重拆 = L0 §2 漏 carry-over =
猫静默退化。本 SOP = 把"重拆"工具化 + 流程化。

## 触发时机（谁命中谁负责）

| 信号 | 动作 |
|------|------|
| `claude --version` / `codex --version` minor 及以上升级（x.**Y**.z / **X**.y.z 变化） | 必跑本 SOP |
| Phase E cron（weekly `--check`）报 `drift=true` | 命中的猫跑本 SOP |
| patch 升级（x.y.**Z**） | 可选；cron drift 会提示，按 diff 大小判断 |

命中升级的猫 = 负责猫（不甩锅、不攒着）。改 L0 走正常 SOP（跨族 review）。

## 步骤

```bash
# 0. 在 worktree（改 L0 = 非 trivial，开 worktree）
# 1. diff 当前 CLI vs 最新归档
node scripts/audit-claude-code-system-prompt.mjs --cli claude \
  --diff docs/audits/cc-system-prompt-v<上一版本>.md
node scripts/audit-claude-code-system-prompt.mjs --cli codex \
  --diff docs/audits/codex-system-prompt-v<上一版本>.md
#   exit 0 = 无 anchor 变化（仍归档新版本 doc 留痕，见 step 4）
#   exit 1 + "new FUNCTIONAL anchor(s)" = 有新功能性指令 → step 2/3
#   exit 1 仅 added/removed 非 functional = 记录即可，无需改 L0
```

2. **看 added functional anchor**：每个新 functional anchor 是"CLI 新增的
   客观性/能力指令"。逐条判断它是否已被 L0 §2 carry-over 覆盖：
   - 已覆盖（同义表述）→ 仅更新归档 doc，注明"已在 L0 §2"
   - 未覆盖 → step 3
3. **提案 L0 §2 carry-over 更新**：在 worktree 改
   `assets/system-prompts/system-prompt-l0.md` §2，把新功能性指令的**语义**
   补进去（不是逐字抄 CC 原文——L0 是重写版；抓"删了猫会丢什么能力"）。
   跑 `compile-system-prompt-l0.test.mjs` 守护 → quality-gate →
   request-review（跨族）→ merge-gate。
4. **归档新版本**（每次升级必做，无论有无 diff——留漂移痕迹）：
   ```bash
   node scripts/audit-claude-code-system-prompt.mjs --cli claude \
     --emit --out docs/audits/cc-system-prompt-v<新版本>.md
   node scripts/audit-claude-code-system-prompt.mjs --cli codex \
     --emit --out docs/audits/codex-system-prompt-v<新版本>.md
   ```
   commit 归档 doc（docs/ truth-sync，可直 main 无 review，同 Phase 文档同步）。

## anchor 清单维护（脚本不自动发现）

`ANCHORS_CLAUDE` / `ANCHORS_CODEX` 是脚本顶部**硬编码常量**（初始来源
`docs/audits/cc-system-prompt-v2.1.143.md` §5）。脚本只 diff **已知** anchor
集 + flag 新/缺。CLI 大版本若新增**全新一类**功能段（已知 anchor 都没覆盖）：
- `--emit` 的身份/§5 仍会产出（已知部分）
- 但全新类别不会自动冒出来——**人工拆**：肉眼扫 `strings $(which claude)`
  新增 `# Xxx` / 功能性关键词段 → 往 `ANCHORS_*` 加新 anchor spec
  （id/label/pattern/functional）→ 再跑 `--diff` 验证 → 同 PR 提交。

> 这是刻意设计（KD-8 同源）：不让脚本"猜"什么是功能性指令，给数据
> （strings + 已知 anchor diff）不给结论，功能性判断留给猫 + reviewer。

## 二进制解析备忘

- **claude**：`which claude` = Bun 编译二进制，`strings` 直接可用。
- **codex**：`which codex` = node launcher 脚本（`#!/usr/bin/env node`），
  `strings` 无用。脚本 `resolveCliBinary('codex')` 复刻 launcher 解析：
  `targetTriple` → `@openai/codex-{triple}` nested vendor 原生 Mach-O/ELF
  二进制（`codexNativeBinaryCandidates`）。codex 重装/换 npm 布局后路径变
  → 解析失败会**报错不静默**（fail-loud），按报错信息修候选路径。

## cron（Phase E AC-E4）

Phase E 注册了 weekly scheduled task：`--check` claude + codex 版本 vs 最新
归档。drift → 发消息提醒猫跑本 SOP。**cron 不自动改 L0**（功能性判断 +
carry-over 是猫/operator 决策，不自动化）。task 管理见 `schedule-tasks` skill。

## 一句话

CLI 升级 → `--diff` → 新 functional anchor 就补 L0 §2（走 SOP）→ `--emit`
归档新版本。不重拆 = 静默丢能力。
