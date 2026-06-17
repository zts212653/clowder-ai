---
feature_ids: [F061]
related_features: [F050, F060]
topics: [cdp, antigravity, bengal-cat, browser-automation, dom-scraping, lessons-learned]
doc_kind: retrospective
created: 2026-03-09
---

# F061 CDP 接入困难与解决方案复盘

> **Status**: done | **Owner**: Ragdoll/Ragdoll
> **Feature**: [F061 Antigravity 接入 — Bengal](F061-antigravity-bengal-cat.md)
> **时间跨度**: 2026-03-04 ~ 2026-03-09（6 天，25+ commits，7 PRs）
> **作者**: Ragdoll/Ragdoll

---

## Why

F061 主线交付后，需要把“接入不可控 Web IDE 的真实踩坑”结构化沉淀，避免后续类似 CDP 集成重复交学费。

## What

1. 系统盘点 F061 的 8 类典型困难（注入、按钮定位、轮询、thinking 提取等）
2. 每类困难给出根因、可复用修法与对应 PR 证据
3. 抽取通用模式，并评估迁移到 ChatGPT Pro Web 的可复用性

## Acceptance Criteria

### Phase A（问题复盘）
- [x] AC-A1: 至少 8 类困难均提供“症状/根因/方案”三元组。
- [x] AC-A2: 每类困难均附关联 PR 或实现证据，便于回溯。

### Phase B（方法沉淀）
- [x] AC-B1: 输出跨项目可复用模式（DOM 私有 API、hidden 状态、轮询误判等）。
- [x] AC-B2: 给出 ChatGPT Pro Web 接入可行性评估与预期新增风险。

## Dependencies

- **Evolved from**: F061 主线实现（Antigravity/CDP 接入）
- **Blocked by**: 无
- **Related**: F050（外部 Agent 接入）/ F060（多模态与 rich 输出链路）

## Risk

| 风险 | 缓解 |
|------|------|
| 外部 Web IDE DOM 结构持续变更导致复盘快速过时 | 保留“模式级结论”而非绑定单一选择器；遇变更先走模式排查 |
| 读者只看结论不看证据，导致误用策略 | 每条结论附 PR 线索与失败案例，要求先复现再复用 |

## 一句话总结

**用 CDP 桥接入一个你无法控制源码的 Web IDE，核心困难全部集中在"DOM 是活的、会变的、有隐藏状态的"这一点上。**

---

## 困难清单 × 解决方案

### 1. 消息注入：Lexical 编辑器不接受 `value` 赋值

| 维度 | 详情 |
|------|------|
| **症状** | `textarea.value = "text"` 无效，Antigravity 用 Lexical 富文本编辑器 |
| **根因** | Lexical 维护自己的 EditorState，直接改 DOM 不会同步到框架内部状态 |
| **解决** | `document.execCommand('insertText', false, text)` — 模拟用户输入，Lexical 能正确接收 |
| **额外坑** | 必须先 `focus()` + `click()` 编辑器区域，否则 `execCommand` 的 target 不对 |
| **PR** | #272 (Phase 1) |

### 2. 发送按钮定位：DOM 结构不稳定 + 多个 "Send" 按钮

| 维度 | 详情 |
|------|------|
| **症状** | 有时点到工具栏的 "Send"（邮件功能）而非聊天的 "Send" |
| **根因** | Antigravity 页面上有多个按钮含 "Send" 文本，全局搜索会误匹配 |
| **解决** | 三层策略降级：① textbox 就近搜索（上溯祖先找 sibling 按钮）→ ② 全局可见文本匹配 → ③ aria-label/title 匹配 |
| **额外坑** | Sub-pass A 优先匹配 send/submit 文本，Sub-pass B 兜底匹配任意小按钮（避免选到 Attach） |
| **PR** | #320 (R1→R2→R3 三轮remote review) |

### 3. 响应轮询：稳定性误判 — 模型思考时被当成"写完了"

| 维度 | 详情 |
|------|------|
| **症状** | Claude Opus 模型的回复在 "Thinking..." 处被截断 |
| **根因** | `stablePollCount=2`：连续 2 次 poll 结果一样就判定完成。但模型 thinking/image generation 暂停期（2-5s）DOM 确实不变 |
| **解决** | ① `stablePollCount` 2→4 ② 新增 Stop 按钮检测——按钮可见说明模型还在工作，阻止 stable count ③ 保留 `hasInlineLoading` 保护 |
| **PR** | #316 |

### 4. 响应轮询：硬超时 vs 空闲超时

| 维度 | 详情 |
|------|------|
| **症状** | 60s 硬超时在 image generation（可能需要 30-120s）时直接截断 |
| **根因** | 固定超时无法适应不同任务的响应时长 |
| **解决** | idle timeout 模式——每次 DOM 有变化就重置计时器，只有 DOM 完全停止变化后才开始倒计时。`maxTimeoutMs=300s` 兜底 |
| **PR** | #313 |

### 5. Thinking DOM 识别：Antigravity 的 thinking 不用标准结构

| 维度 | 详情 |
|------|------|
| **症状** | Bengal抓回来的内容有重复、包含 thinking 文本、CSS 垃圾 |
| **根因** | 代码只认 `<details>` / `[class*="thinking"]`，但 Antigravity 用 `<button>Thought for 16s</button>` + `<div class="max-h-0 opacity-0">` 折叠容器 |
| **解决** | ① 扩展检测：匹配 "Thought for Xs" 按钮 + 遍历折叠 sibling ② `extractBlockText` 重写为 clone-first：先 strip hidden 子树再提取文本 ③ thinking sibling 也走 `extractBlockText` 净化（不直接 `textContent`） |
| **教训** | **第一版只修了 responseText，没修 thinkingText——"把垃圾从一个桶挪到另一个桶"不算修好。** Review 抓住了这个问题 |
| **PR** | #330 (本地 codex R1→R2 + 云端 R1→R2) |

### 6. CDP Target 选择：连错页面

| 维度 | 详情 |
|------|------|
| **症状** | CDP 连上了 Antigravity 的 Launchpad 页面而非编辑器页面 |
| **根因** | `CDP.List()` 返回多个 target，没有过滤逻辑 |
| **解决** | target 排名策略：过滤 Launchpad → 按 title hint 排序 → 健康探测（发 `Runtime.evaluate` 验活） |
| **PR** | #292 |

### 7. 消息发送：多策略降级

| 维度 | 详情 |
|------|------|
| **症状** | 有时 Enter 键不触发发送（Antigravity 的键盘事件处理不一致） |
| **根因** | 不同场景下 Antigravity 对键盘事件的响应不同 |
| **解决** | 三策略降级：① 按钮点击（coordinates）→ ② JS dispatchEvent Enter → ③ CDP `Input.dispatchKeyEvent` |
| **PR** | #286 |

### 8. @owner 提及检测：agent stream 路径遗漏

| 维度 | 详情 |
|------|------|
| **症状** | Bengal @ operator但operator没收到通知 |
| **根因** | `detectUserMention` 只在 MCP callback 路径（callbacks.ts），agent stream 路径（route-serial.ts）没有 |
| **解决** | 在 route-serial.ts 的 textContent 处理块中加入 `detectUserMention`，结果写入 `messageStore.append` + WebSocket `done` yield |
| **PR** | #320 |

---

## 通用模式：CDP 接入 Web AI IDE 的必经之坑

从 F061 六天的经验中，提炼出的通用模式：

### 模式 A：DOM 是私有 API，没有契约

Web IDE 的 DOM 结构 = 实现细节，不是 public API。每次 IDE 更新都可能：
- 改 class name（`whitespace-pre-wrap` → 别的什么）
- 改 thinking 容器结构（`<details>` → button + 折叠 div）
- 改按钮文本（"Send" → icon-only）

**对策**：多层降级选择器 + 回归测试覆盖已知结构。

### 模式 B：隐藏状态 ≠ 不存在

DOM 里有 `display:none`、`max-h-0 opacity-0`、`aria-hidden="true"` 的元素——它们在 DOM 树里存在，`textContent` 会把它们的内容一起抓出来。

**对策**：任何文本提取都必须先 clone → strip hidden → 再读取。永远不信 `textContent`。

### 模式 C：轮询稳定性 = 假阳性地雷

"连续 N 次结果一样 = 完成"这个假设在 AI 模型场景下很脆弱：thinking 暂停、image generation 暂停、网络延迟都会让 DOM 暂时不变。

**对策**：① 加大 N ② 引入积极信号（Stop 按钮、Loading indicator）③ idle timeout 替代固定超时。

### 模式 D：一个 bug 修一半 = 新 bug

把脏数据从 field A 挪到 field B，field A 看着干净了但 field B 坏了。特别是 responseText/thinkingText 这种一体两面的场景。

**对策**：行为测试（构造 DOM → eval 脚本 → 断言所有输出字段）。字符串 `includes` 断言只能保证脚本有某段代码，不能保证代码正确工作。

---

## 如果接入网页版 ChatGPT Pro（Maine Coon Pro），会遇到同样的事情吗？

**简短回答：是的，会遇到几乎完全一样的困难，而且可能更难。**

### 相同的坑

| 困难 | F061 (Antigravity) | ChatGPT Pro Web |
|------|---------------------|-----------------|
| Lexical/ProseMirror 编辑器 | ✅ Antigravity 用 Lexical | ✅ ChatGPT 也用 ProseMirror/类似方案 |
| thinking DOM 隐藏结构 | ✅ button + 折叠容器 | ✅ ChatGPT 也有 "Thought for Xs" 折叠 |
| 多个 Send 按钮 | ✅ 工具栏 vs 聊天 | ✅ ChatGPT 有搜索、语音等多按钮 |
| 轮询稳定性误判 | ✅ model thinking 暂停 | ✅ o3/o4-mini 思考时间更长 |
| DOM 结构随版本变 | ✅ Antigravity 更新频繁 | ✅ ChatGPT 更新更频繁（周级） |

### ChatGPT Pro 额外的新坑

| 新困难 | 原因 | 预估难度 |
|--------|------|----------|
| **Cloudflare 人机验证** | ChatGPT 有 Turnstile/WAF，CDP 自动化可能触发 | 🔴 高 |
| **SSE streaming** | ChatGPT 用 server-sent events，DOM 更新粒度更细（逐 token），轮询策略需要调整 | 🟡 中 |
| **Canvas/Artifacts 模式** | ChatGPT 有侧边 canvas（代码编辑、文档），DOM 结构完全不同于普通聊天 | 🟡 中 |
| **多模态输出** | DALL-E 图片、代码执行结果嵌入聊天，提取逻辑复杂 | 🟡 中 |
| **频率限制** | ChatGPT Pro 有 per-model rate limits，自动化高频可能触发 | 🟡 中 |
| **CSP 和 iframe 隔离** | ChatGPT 的 CSP 策略可能限制 CDP `Runtime.evaluate` | 🟡 中（需验证） |

### 可复用的 F061 经验

| 经验 | 复用度 |
|------|--------|
| 三层按钮定位策略 | ✅ 直接复用思路，换选择器 |
| clone-first 文本提取 | ✅ 直接复用 `extractBlockText` 模式 |
| idle timeout 替代硬超时 | ✅ 直接复用 |
| Stop/Loading 积极信号检测 | ✅ ChatGPT 也有 Stop 按钮 |
| JSDOM 行为测试方法 | ✅ 直接复用测试框架 |
| target 健康探测 | ✅ 直接复用 |
| `execCommand('insertText')` | ⚠️ 需验证 ChatGPT 编辑器是否兼容 |
| 模型切换 DOM 脚本 | ❌ 需要重写（UI 完全不同） |

### 建议

如果真的要接入 ChatGPT Pro Web：
1. **Phase 0 Spike 必须先做**——用同样的 5 路径评估模板，特别要验证 Cloudflare 和 CSP
2. **复用 F061 的 `extractBlockText` + idle timeout + 行为测试模式**——这些是通用的
3. **预期修 bug 的密度与 F061 相当**——6 天 7 个 PR 是正常节奏，不是意外
4. **考虑 ChatGPT API 是否更划算**——如果有 API access，CDP 桥完全不必要。CDP 只在"没有 API、只有 Web UI"的场景下才值得投入

---

## 附录：PR 时间线

| 日期 | PR | 内容 | Review 轮数 |
|------|----|------|-------------|
| 03-04 | #272 | Phase 1: CDP 桥 + AgentService + 注册 | codex R2 + 云端 |
| 03-05 | #283 | CDP 稳定性：超时配置、WS 生命周期、错误处理 | codex R2 + 云端 |
| 03-05 | #286 | 多策略 sendMessage（按钮/JS Enter/CDP） | codex R1 + 云端 |
| 03-06 | #292 | Target 健康探测 + 过滤 + debug 日志 | codex R1 + 云端 |
| 03-08 | #313 | Idle timeout + thinking 分离 | codex R2 + 云端 |
| 03-08 | #316/#317 | 稳定性误判 + 模型切换 | codex R2 + 云端 R3 |
| 03-08 | #320 | Send 按钮定位 + @owner mention | codex R1 + 云端 R3 |
| 03-09 | #330 | Thinking DOM 识别 + hidden 过滤 | codex R2 + 云端 R2 |
