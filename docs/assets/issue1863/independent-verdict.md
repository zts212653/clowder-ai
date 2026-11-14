# Issue #1863 · 独立验收结论（鲸鲸）

日期：2026-11-05。最终 exact HEAD：`2645d8f3bd24b50732409492e400fabcefd84d1b`，分支 `explore/issue1863-composer-links`，基线 `471b56a4`。性质：探索效果稿的独立验收，**不是**正式产品上线批准。

## 裁判

**可作为探索效果稿交给 zts（非正式产品验收）。** 最终 HEAD 没有 P1/blocking。

## aaac → 2645 差异复核

- `ComposerLinkMirror.tsx`：产品层删掉正常流 warning，只在 `aria-hidden` 镜像上加 `data-unmapped`；演示宿主自己用 MutationObserver 读它并显示缺口。**产品层不再影响布局/读屏**，上一轮 P2 #1 已解。
- `remark-chat-references.ts`：删掉 `source.indexOf`；仅当 `source.slice(node.position) === node.value` 时，用该 text node 内的 token 偏移赋 position。转义/entity 明确不猜，计 `unmapped`。
- `composer-web-links.ts`：fastpath 放行 `&`/`\`，让转义/entity 也进入解析并暴露缺口；不再把 `https\://…` 静默当无链接。
- 单测新增 escaped 反例；作者报 30/30。我没有复跑 Vitest，但用浏览器独立验证了 escaped gap：`data-unmapped=1`、无标记、演示宿主 warning 出现。
- 关闭 headless 的 `--hide-scrollbars` 后，**15px gutter 存在**；三个宽度仍精确同高/同 scrollTop。

## 我实际跑过的（最终 HEAD）

- **40/40 输入样例**：真实 `ChatInput` + `MarkdownContent` + `ChatReferenceScope`；每例独立隔离宿主（`?text=` 初始值），输入侧读 `mark[data-link-start/end]`/`data-link-href`，发送后读真实气泡 `a[href]`，与 `acceptance-cases.json` 逐项比。0 失败。
- **5/5 编辑操作**：引用定义 one/two、删定义、选区替换、原生键入空格 + 撤销/重做。
- **几何 3/3（含 15px 滚动条）**：1180/760/390px 下 textarea/mirror `scrollHeight` 均相等（1232/1232、1232/1232、3032/3032），滚到底 `scrollTop` 均相等（1032、1112、2912），`clientWidth` 与镜像宽相等（687/663/293），无横向溢出。
- **IME**：CDP composition 组字时镜像 `hidden`，提交后输入值与标记恢复；**refresh**、**暗色**、**classic（mirror 0）**通过；`pageerror` 0。
- **escaped gap**：`https\://example.com` → `data-unmapped=1`、产品层无标记、演示宿主 warning；符合“明确暴露缺口，不猜位置”。

原始结果：`independent-acceptance-results.json`；截图：`independent-01-bare-cn.png`、`independent-02-space.png`、`independent-03-reference.png`、`independent-05-narrow.png`、`independent-06-dark.png`、`independent-07-classic.png`、`independent-08-selection.png`。

## P1

无。

## P2（正式实施前收；不影响这次作为效果稿）

1. **产品层缺口仍不可见，只有 `data-unmapped`**：演示宿主能看到 warning，正式产品如果直接接这层，用户看到的是“某段没标但发送后可能仍是链接”，没有可见说明。正式实施需要产品自己的缺口处理（原位提示/说明），不能只靠属性；这次效果稿由宿主提示，够用。
2. **新对话“发送前无 threadId / 乐观帧”没有 fixture 证明**：`issue1863-composer.tsx` 仍始终把已发送消息包在 `ChatReferenceScope` 里。composer 用 `references:true` 计算是对的，最终 scoped 气泡也过；但“thread 建立前气泡不带引用插件”的瞬态未覆盖。作者稿已把完整 API 新线程旅程标为未验；交付时沿用这个口径，不要再写成“完整新会话 E2E 已验”。
3. **existing-thread 入口未在我的 40 例单独跑**：我的 40 例是 per-case fresh host（新会话初始值）；作者浏览器脚本在首条发送后跑了 7 个源，覆盖一部分。band parser 与 threadId 无关，风险低，但交付时写清入口覆盖差异。
4. **实体 Windows IME 候选词、macOS、完整产品 API 创建线程/后端持久化/重启恢复未验**；CDP composition 不能代替实体候选词。
5. **IME 组字时整层隐藏**是作者有意的取舍（end 后恢复）；我测到行为一致，会有一次可见的标记消失/恢复。探索稿可接受；正式产品要不要冻结旧范围需产品判断。
6. **escaped/entity 明确是不覆盖缺口**：演示宿主 warning 是诚实的，但不能宣称“全覆盖”；正式实施的覆盖范围要另定。

## P3

- `color-mix(in srgb, var(--shell-primary-text) …)` 计算出的颜色有负 blue 分量（`color(srgb 0.416 0.111 -0.0937 / 0.68)`）；Chromium 渲染成暖色线，跨浏览器更稳可用 `oklab` 或直接用 sRGB token。
- `createMarkdownProcessor` 经 `@cat-cafe/ui` barrel 进 composer，可能把整个 UI 包带进聊天 chunk；建议挪到纯模块。
- 作者报纯解析 16600 字中位 12.8ms / p95 13.6ms；我没有独立复测，作为作者侧测量记录，不当作本结论的独立证据。

## 过程中修掉的假阳性（不是产品失败）

1. 第一轮我的浏览器脚本在用例间残留宿主草稿，出现“新输入 + 旧输入”的假失败。改为每个用例一个隔离宿主页面后消失。
2. `indented-code` 我最初把“草稿开头 4 空格 + URL”当代码块期望不标记；但发送会 `trim()`，最终是链接。实现与发送语义一致；已改成内部缩进代码（`前文\n\n    URL`）作为真负例；开头 4 空格的 trim 行为由作者单测覆盖。
3. `bare-trailing-ascii-dot` 的 `notMarked:["."]` 会匹配 URL 内部的点（`github.com`），是我的断言歧义；改用标记区间结束位置验证，实现正确。

## 结论边界

- 覆盖：真实 `ChatInput` v2 + 真实 `MarkdownContent`/`ChatReferenceScope` 在隔离宿主里的输入、发送、气泡、几何（含常规滚动条）、选区、CDP composition、暗色、classic、escaped gap。
- 不覆盖：完整 API 新线程、后端消息存储/重启恢复、实体 Windows IME 候选词、macOS、正式视觉签字、正式产品范围。
- 不能把本结论写成“正式功能已完成”或“可以合并 PR”；它支持的是**把效果稿交给 zts 讨论**。
