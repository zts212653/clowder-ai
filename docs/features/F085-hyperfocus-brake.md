---
feature_ids: [F085]
related_features: [F066]
topics: [健康, 提醒, hook, skill, 猫设]
doc_kind: spec
created: 2026-03-08
status: done
completed: 2026-03-11
reflection: project-reflections/2026-03-09-f085-hyperfocus-brake-capsule.md
---

# F085 Hyperfocus Brake — 猫猫健康小刹车

> **Status**: done | **Completed**: 2026-03-11 | **Owner**: Ragdoll

## Why

operator有 ADHD + ASD，hyperfocus 特质让他能进入超级深度的心流状态，但**没有自动刹车**。他不会像普通人一样"累了就不想干了"——会一直干到身体物理罢工。

普通闹钟对 hyperfocus 状态无效（会被冷酷无情按掉）。需要：
1. **情感羁绊** — 三只猫猫撒娇，不是机械提醒
2. **上下文感知** — 知道operator在干嘛，提到具体内容
3. **互动门槛** — 不能一键 dismiss，要强制互动

## What

一个 **平台级健康守护**，每 90 分钟（可配置）活跃工作后触发三猫联合撒娇提醒。

### 核心机制

- **触发源**：Hook-first（`PostToolUse` 累计活跃时长）+ `/loop` 兜底
- **内容生成**：orchestrator 读白名单上下文，生成三猫文案（不真拉三模型）
- **互动门槛**：typed check-in（三选一：休息/收尾/继续+理由）
- **Emergency bypass**：输入理由 + 30min 冷却

### 分阶段实现

| Phase | 内容 | 交付物 |
|-------|------|--------|
| **1 - MVP** | skill + hook + 三猫文案 + typed check-in | 可用的健康提醒 ✅ |
| **2 - 增强** | 富文本 card + 触发次数升级语气 | 更丰富的视觉 ✅ |
| **3 - 声控** | F066 声线集成 + 语音撒娇 | 三猫语音轮流撒娇 ✅ |
| **4 - 平台化** | 从 agent hook 迁移到后端 API + 前端 UI | 三猫全覆盖、无 agent 依赖 ✅ |
| **5 - UX 增强** | Hub 开关 + TTS 自动播放 + 猫猫图片 | 完整感官体验 |

## Acceptance Criteria

- [x] AC-A1: Hyperfocus Brake 核心提醒链路已交付（详见下方条目）

### Phase 1 (MVP)

- [x] **AC1**: skill `hyperfocus-brake` 可通过 `/loop 90m /hyperfocus-brake` 触发
- [x] **AC2**: Hook (`PostToolUse`) 累计活跃时长，到阈值触发 skill
- [x] **AC3**: 上下文采集白名单：git status/diff/log、当前 branch、BACKLOG/TODO
- [x] **AC4**: 生成三猫文案（L1 温柔 / L2 关心 / L3 急了），根据忽略次数升级
- [x] **AC5**: 必须 typed check-in 才能继续（1=休息 / 2=收尾10min / 3=继续+理由）
- [x] **AC6**: Emergency bypass（递增代价：30min → 45min → 第3次禁用）
- [x] **AC7**: 纯文本输出 + rich card 降级版
- [x] **AC8**: 夜间模式（23:00 后轻声细语，无闪烁）
- [x] **AC9**: 占位符注入防护（allowlist + escape + length cap 80）
- [x] **AC10**: 恶意 branch 名注入测试（含 `] @ ``` <script>`）不污染 card
- [x] **AC11**: 超长 branch/message 被截断测试
- [x] **AC12**: bypass 冷却计时跨 session 仍生效测试
- [x] **AC13**: 4h 内重复 bypass 升级冷却测试
- [x] **AC14**: 夜间模式无强刺激样式测试

### Phase 2

- [x] **AC15**: 富文本 `card` rich block 展示
- ~~AC16~~: Chrome 画专属撒娇图 → 裁出为独立 TD（非核心体验，不阻塞 F085 close）
- [x] **AC17**: 触发次数追踪 + 语气自动升级（card tone: L1=info, L2=warning, L3=danger）
- ~~AC18~~: 肉垫点击解锁 → 裁出为独立 TD（Web 端交互增强，非核心）

### Phase 3

- [x] **AC19**: F066 声线集成（speaker 字段 + VoiceBlockSynthesizer per-block override）
- [x] **AC20**: 三猫语音轮流撒娇（Ragdoll→Maine Coon→Siamese，各用自己声线）

### Phase 4 (平台化)

**Gap**: Phase 1-3 的 hook 方案绑在 Claude Code 的 `settings.json` 上，只有Ragdoll能触发提醒。Maine Coon（Codex）和Siamese（Gemini）的 session 完全不覆盖。根因：把平台级能力挂在了 agent 工具链上。

- [x] **AC21**: 后端 API 活跃时长追踪 — 每次 API 请求更新 `lastActivityTs`，5min 间隔检测
- [x] **AC22**: 后端触发判定 — 到阈值推 WebSocket event `brake:trigger` 给前端
- [x] **AC23**: 前端 UI 通知 — 订阅 brake event，弹猫猫提醒卡片（含头像 + 撒娇文案）
- [x] **AC24**: 前端 check-in 交互 — 三选一（休息/收尾/继续）直接在前端完成
- ~~AC25~~: 前端 TTS 播放 → 裁出为 TD108（依赖 F066 前端播放基建，非核心体验，不阻塞 F085 close）
- [x] **AC26**: 三猫全覆盖 — 无论operator在跟哪只猫聊天，都能触发提醒
- ~~AC27~~: agent hook 退役 → 裁出为 TD109（需验证平台 brake 稳定 1 周+，不阻塞 F085 close）

### Phase 5 (Brake UX 增强)

**Gap**: Phase 4 把提醒迁到了前端，但 UX 仍是朴素的：没有语音（之前裁出的 TD108）、没有猫猫图片、没有开关。operator想要：(1) Hub 里能开关 brake，(2) 弹窗时猫猫语音自动播放，(3) 弹窗里有猫猫图片增加情感。

- [x] **AC28**: Hub 开关 — Hub Settings 新增 Brake 面板，含 enable/disable toggle + 阈值调节（默认 90min）
- [x] **AC29**: 前端 TTS 自动播放 — brake 弹窗弹出时，用 `useTts.synthesize()` 自动播放当前猫的撒娇语音（回收 TD108）
- [x] **AC30**: 猫猫图片增强 — brake 弹窗内三猫头像从 36px 放大 + 增加猫猫表情/动作图片（撒娇、睡觉、叉腰），提升情感冲击力
- ~~AC31~~: 配置持久化 → 裁出为 TD110（当前 in-memory Map 满足浏览器刷新场景，真持久化需 Redis/DB，不阻塞 F085 close）

## Key Decisions

| 决策 | 结论 | 理由 |
|------|------|------|
| 触发源 | Hook-first + `/loop` 兜底 | Maine Coon Codex 建议，现有 hook 体系成熟 |
| 计时基准 | 活跃工作时长（非 wall clock）| 避免离开吃饭回来误报 |
| Phase 1 交互 | typed check-in only | 终端场景鼠标不稳，可访问性优先 |
| 肉垫点击 | → Phase 2 (Web) | Maine Coon建议 |
| 三猫调用 | orchestrator 生成三段文案 | GPT-5.4 建议，不真拉三模型 |
| 声线顺序 | Ragdoll → Maine Coon → Siamese | 按家族顺序 |
| Phase 4 平台化 | hook → API + 前端 | Phase 1-3 只覆盖 Claude，Maine CoonSiamese无保护 |
| Phase 5 TTS | 复用 `useTts` + `AudioBlock` | F066 前端播放基建已就绪，TD108 可直接回收 |
| Phase 5 图片 | 放大头像 + 新增表情动作图 | operator明确要求"猫猫发图片" |

## Dependencies

- **Evolved from**: 云端 Opus 4.5 招募令（2026-03-08）
- **Blocked by**: 无
- **Related**: F066 (TTS)、F073 (SOP Auto Guardian)

## Risk

| 风险 | 缓解 |
|------|------|
| 上下文采集泄露敏感信息 | 白名单（git/feature/todo），禁读 .env/auth/token |
| **P1 占位符注入** | 动态上下文纯文本渲染，allowlist `[A-Za-z0-9._/-]`，max 80 chars，escape `@`/反引号/方括号 |
| **P1 bypass 滥用** | 递增代价：30min → 45min → 第3次禁用（只允许收尾10min）|
| 强制交互在紧急修复时反噬 | Emergency bypass + 递增冷却 + 可审计日志 |
| `/loop` 稳定性未验证 | Hook 为主触发，`/loop` 兜底 |

## Review Gate

- [x] Phase 1: Maine Coon Codex review hook 安全性 (R1-R4 本地 + R1-R2 云端, PR #329)
- [x] Phase 2+3: Maine Coon Codex review LGTM (0 P1/P2, P3 补测试已修)
- [x] Phase 4: Maine Coon Codex 本地 R1-R2 (2P1+1P2 全修) + 云端 R1-R2 (1P1 全修, LGTM)
- [x] Phase 5: Maine Coon Codex 本地 R1 (2P1+1P2 全修) + R2 LGTM (0 P1/P2)

## 需求点 Checklist

Phase 1 需求点追踪：

| # | 需求点 | 来源 | 状态 | 验证方式 |
|---|--------|------|------|----------|
| 1 | 90min 活跃时长触发 | 招募令 | done | state.test.sh |
| 2 | 三猫联合撒娇 | 招募令 | done | messages.sh + integration |
| 3 | 上下文感知（git/branch/todo）| 招募令 | done | sanitizer.test.sh |
| 4 | typed check-in 门槛 | 讨论共识 | done | state.test.sh |
| 5 | emergency bypass | Maine Coon Codex | done | state.test.sh |
| 6 | 夜间模式 | Siamese | done | integration.test.sh |

## 分工

| 猫猫 | 任务 | 状态 |
|------|------|------|
| **Opus 4.5** | skill 骨架 + hook 触发逻辑 + renderer 抽象 | 初版完成，Opus 4.6 接力修复 ✅ |
| **Codex** | hook 安全审查 + emergency bypass 逻辑 + 上下文白名单 | R1-R4 review 完成 ✅ |
| **Gemini** | 三档文案 + card 草案 + 视觉规范 | 已存入 refs/ ✅ |
| **Opus 4.6** | R1-R4 修复 + remote review + merge | Phase 1 合入 main ✅ |
