# r3b12：七项旧失败的逐项判定（删除前记录）

基线为 176132d360；按 lang 本轮决定，画法检查随已被 PDL 替代的旧画法撤掉，真实行为断言保留。

| 原失败 | 判定与依据 | 本轮处理 |
| --- | --- | --- |
| f190 / src-wide raw pixel font definitions | 旧画法：扫描 src 中的 JSX / CSS 字符串（且把 rem 的 font-size 也匹配进来），没有读取原样 public/pdl 的 token／组件，不测请求、状态或效果 | 删除这个用例／空 describe；保留其余 v2 token 检查与 CSS，不重写扫描使其通过 |
| f190 / ActionRenderer QR shadow vs border | 旧画法：只断言旧 ActionRendererParts.tsx 包含 shadow 类、不含 border 类；宿主没有挂载这个 JSX | 删除这个用例；不改组件及插件逻辑 |
| f190 / IndexStatus toggle bg-cafe-accent | 旧画法：只扫描旧 IndexStatus.tsx 的按钮类字符串；新 PDL 使用组件库的通用 switch | 删除这个用例；真实开关 GET/PATCH 的 IndexStatus-feature-flags 测试保留 |
| original-terminal-effect / zh Inbox F225 approved | 真实行为：已确认的接力效果应保留，展开不再写入；不是样式检查 | 保留断言；核对真实 session owner 与 producer 回执读取，修复测试所缺的身份数据或实际回归，不让 approved 代替效果证明 |
| original-terminal-effect / zh Inbox F231 approved | 真实行为：已提交的画像写入效果应保留；拒绝重复写入 | 同上，保留断言 |
| original-terminal-effect / en Inbox F225 approved | 同一个效果在英文入口的表达；不是另一套界面规则 | 同上，保留断言 |
| original-terminal-effect / en Inbox F231 approved | 同一个画像效果在英文入口的表达 | 同上，保留断言 |

先记录上表，再删除前三个用例；四个结果断言不删、不放宽。其余旧候选仍按 r3b11 清单保留。

最终核对：四个 Inbox 用例缺少 HttpOnly API session 的已确认身份。生产 reader 会把未确认身份的读取挡在 producer 证明之前，测试却只传了卡片里的 owner 字符串，且将 `/api/session` 错配成 proposal body。补齐 fixture 的 `observeApiSessionOwner('owner-1')`，每例前后清 canonical cache 并恢复身份；没有放宽实际 reader 或结果断言。原文件 12 项全部通过。这个分类仍属于真实行为覆盖，**保留测试**；此次没有发现需要放宽身份规则的生产回归。

r3b11 的三个旧组件及两个专属测试已由 lang 提交删除。本轮只删上表前三个已列明的画法用例，没有继续删除尚有 owner／v2 使用者的组件、没有动 dot 插件或 IndexStatus 的真实开关逻辑。
