# Issue #1863 · 独立验收结论（鲸鲸）

日期：2026-11-06。最终 exact HEAD：`d5d1b9d34870f84d2c3666a013cfc3e1883421f3`，分支 `explore/issue1863-composer-links`。性质：**蓝字探索效果稿**的独立验收，**不是**正式产品上线批准。

## 裁判

**可作为探索效果稿交给 zts（非正式产品验收）。** 蓝字/选区/IME 恢复没有发现真实 blocking；正式实施前仍有 P2 收口项。

## f03c3247 → d5d1b9 差异复核

- 只改两个绘制文件：`ComposerLinkMirror.tsx` 增加 `active = ranges.length > 0 && !composing` 与 `data-active`；CSS 在 active 时把 textarea 文字设为透明，保留 `caret-color` 与 `::selection`，`.range` 改为蓝字，正文保持 `var(--shell-ink)`；dark 覆盖 `#93c5fd`。
- **URL 解析、`ChatInput` 编辑处理、发送/气泡语义未改**；这轮不是换编辑器，也不是重写链接识别。
- 无链接或组字时 `active=false`：viewport 隐藏，textarea 恢复原生文字；组字结束再切回蓝字/透明。
- 选区用系统 `Highlight`/`HighlightText`，与 DESIGN 的“选区保留系统高亮”一致。
- 蓝字覆盖的是既有 `mark` 区间，即“整段会生成链接的源构造”：裸 URL、显式/引用式使用处、行内代码 URL；不是只给 URL 地址上色。这是上一轮已定的语义，不是本轮新增。

## 我实际跑过的（蓝字 HEAD）

- **40/40 输入样例**：真实 `ChatInput` + `MarkdownContent` + `ChatReferenceScope`，每例独立隔离宿主；输入侧区间/`data-link-href` + 发送后真实气泡 `a[href]`，对 `acceptance-cases.json`。0 失败。
- **5/5 编辑操作**：引用定义 one/two、删定义、选区替换、原生键入空格 + 撤销/重做。
- **几何 3/3（含 15px gutter）**：1180/760/390px 两层 `scrollHeight` 均相等（1232/1232、1232/1232、3032/3032），滚到底 `scrollTop` 均相等（1032、1112、2912），`clientWidth` 与镜像宽相等（687/663/293），无横向溢出。
- **IME**：CDP composition 组字时镜像 `hidden`、textarea 原生文字；提交后蓝字恢复；**refresh**、**classic（mirror 0）** 通过；`pageerror` 0。
- **escaped gap**：`https\://example.com` → `data-unmapped=1`、无标记、演示宿主 warning；仍是明确缺口，没有猜位置。

### 蓝字/选区/IME 专门检查（6/6）

| 检查 | 结果 |
|---|---|
| 浅色链接蓝 + textarea 透明 + caret 可见 | 通过；`mark` 为 `rgb(37, 99, 235)`，textarea 为 `rgba(0, 0, 0, 0)`，caret 为 ink |
| 选区保留系统高亮、选中文字可见 | 通过；selected 文字白、背景 `Highlight`（浅色 `rgb(0, 120, 215)`） |
| 暗色链接蓝 + 正文原色 | 通过；`mark` 为 `rgb(147, 197, 253)`，正文为 `oklch(0.95 …)` |
| 无链接恢复原生文字 | 通过；textarea 为 `oklch(0.2 …)`，mirror `hidden` |
| 组字时恢复原生文字 | 通过；textarea 原生色，mirror `hidden` |
| 组字结束恢复蓝字/透明 | 通过；textarea 透明，mirror 可见，`mark` 浅色蓝 |

截图：`blue-01-light.png`、`blue-02-selection.png`、`blue-03-dark.png`；结果：`blue-check-results.json`、`independent-acceptance-results.json`。

## 蓝字/选区的判断

- **蓝字本身成立**：浅色 #2563eb 在奶油底上清楚，暗色 #93c5fd 在暖黑上清楚；正常字重、无图标、无下划线，和枫哥要的“链接蓝字”一致。
- **正文原色成立**：viewport 用 `var(--shell-ink)`，非链接文字不蓝；截图里 ` 这不是` 是正文色。
- **选区成立**：textarea 的 `::selection` 用系统 Highlight/HighlightText，选中文字白、背景蓝，mirror 的蓝字被系统选区盖住；没有出现“选中后看不见字”或“蓝字和选区叠成两层”的问题。
- **IME 恢复成立**：组字时 `data-active=false`，mirror 隐藏，textarea 原生文字；提交后同一帧内恢复透明/蓝字。CDP composition 只能证明 Chromium 事件路径，实体 Windows 候选词仍未验。
- **caret 成立**：textarea 文字透明时 `caret-color: var(--shell-ink)` 显式保留；截图/计算样式都能看到；没有出现“光标也透明”的问题。
- **没有真实 P1**：蓝字、选区、caret、无链接恢复、组字恢复都通过；没有发现“文字重影”“选区吞字”“组字丢字”“蓝字只出现一半”这类问题。

## P2（正式实施前收；不影响这次作为探索稿）

1. **完整 API 新线程/后端持久化仍是未验**：作者稿已标；fixture 的 post-send 气泡始终在 `ChatReferenceScope` 里，无法证明“thread 建立前的乐观帧”也不闪蓝/闪链接。沿用“完整 API 旅程未验”，不要写成完整新会话 E2E 已验。
2. **existing-thread 入口未在我的 40 例单独跑**：我的 40 例是 per-case fresh host；作者浏览器脚本首条发送后跑了若干源，覆盖一部分。band parser 与 threadId 无关，风险低，但交付写清入口覆盖。
3. **产品层缺口仍只有 `data-unmapped`**：演示宿主有 warning；正式产品若直接接这层，用户看不到“未标但发送后可能仍是链接”的说明。正式实施需要产品自己的缺口处理。
4. **实体 Windows IME 候选词、macOS、完整后端未验**；CDP composition 不能代替实体候选词。
5. **组字时蓝字暂时消失**是有意取舍：组字显示原生文字，结束后恢复蓝字；会看到一次颜色切换。探索稿可接受；正式产品是否改成冻结旧蓝字范围需要产品判断。
6. **蓝字覆盖整段源构造**（显式链接的方括号/标签、行内代码的反引号也会蓝）。这是上一轮定的“范围”语义；如果正式产品只想蓝 URL 地址或标签，需另行定义，不是本轮 bug。
7. **选区是系统高亮，不是设计 token**；DESIGN 已写“保留系统高亮”。若后续要品牌化选区色，需另做设计，不影响本轮。

## P3

- `createMarkdownProcessor` 仍经 `@cat-cafe/ui` barrel 进 composer，有 bundle 风险；可挪纯模块。
- `.viewport[data-active="true"] + textarea` 依赖 viewport 是 textarea 的紧邻前兄弟；当前 DOM 成立，但后续若在中间插节点会静默失效，建议加一条回归断言/注释。
- 全透明 textarea + 全量镜像让“文字对齐/caret 位置”比只画下划线更吃字体度量；本轮 3 宽度、15px gutter、选区、CDP composition 都过，但 zoom/其他字体仍属未穷尽。
- 作者报纯解析 16600 字中位 12.8ms / p95 13.6ms；我没有独立复测，不作为本结论的独立证据。

## 结论边界

- 覆盖：真实 `ChatInput` v2 + 真实 `MarkdownContent`/`ChatReferenceScope` 在隔离宿主里的输入、发送、气泡、几何（含常规滚动条）、蓝字、caret、系统选区、CDP composition、暗色、classic、escaped gap。
- 不覆盖：完整 API 新线程、后端消息存储/重启恢复、实体 Windows IME 候选词、macOS、正式视觉签字、正式产品范围。
- 不能把本结论写成“正式功能已完成”或“可以合并 PR”；它支持的是**把蓝字效果稿交给 zts 讨论**。
