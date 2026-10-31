# Review Request: Console 成员名称统一按运行时 roster 投影

Review-Target-ID: issue-1180-member-identity
Branch: fix/1180-console-member-labels
Implementation commit: `eb645aeec172d7d663914ed69c685b7257e4db84`

## What

- 新增统一的成员显示解析层：普通界面使用 `displayName（variantLabel）`，未知成员回退原始 `catId`；诊断界面使用 `友好名称 · catId`。
- Queue A2A 调用链、等待原因以及 Console 中其他非成员配置位置统一从运行时 `/api/cats` roster 投影名称。
- 后端 payload、路由、筛选、持久化和事件事实仍以 `catId` 为准；公开 Story Export 的匿名化语义保持不变。
- `useCatData({ fetch: false })` 允许叶子组件只订阅共享 roster cache，不各自发起请求；根布局里的 `CatHueInjector` 继续负责主动加载 roster。

## Why

Queue 行把 `cat-8zfu14fb → cat-8zfu14fb` 直接展示给用户，而对话区域已有更友好的成员名称。根因不是数据缺失，而是多处 Console 展示绕过了运行时成员 roster，混用了原始 ID、静态别名和局部格式化逻辑。

## Original Requirements（必填）

> “我们队列的a2a消息这里回显的是catid对用户不是很友好的；应该和我们的对话哪里一样用 名称+后缀的形式比较友好的。”
> “我们其实只需要有个成员数据；然后根据成员catid映射到成员数据做渲染的。”
> “我们只是console显示需要统一format调整；实际的数据不应该调整的。”
> “Console所有涉及到成员名称出了成员配置哪里之外的位置都是可以按照这个思路来渲染和显示的。”

- 来源：[GitHub issue #1180](https://github.com/zts212653/clowder-ai/issues/1180) 与当前协作 thread。
- 请 reviewer 重点判断：实现是否始终停留在 Console 展示投影，且成员配置、真实数据、路由身份和公开匿名化没有被改写。

## Tradeoff

- 没有新增后端 display-name 字段或改写事件数据；统一复用现有 runtime roster，避免形成第二份成员真相源。
- 叶子组件被动订阅 cache，把 I/O 所有权留给根级 loader；代价是 roster 首次到达前短暂显示 raw `catId`，随后自动更新。
- 未知 ID 保留 raw 值，避免用错误别名掩盖配置/数据问题；技术诊断位置保留 raw ID 作为次级信息。

## Architecture Ownership（必填）

Architecture cell: identity-session（identity-agent subcell）
Map delta: none
Why: 本次只消费既有 canonical runtime roster 做前端 presentation projection；没有改变成员配置 owner、schema、边界、extension anchor，也没有新增 Store / Queue / Router / Adapter / Dispatcher / Binding。

请 reviewer 检查：

- 66 个文件的展示扫描是否与 `Map delta: none` 一致，是否有任何数据或身份语义被意外改写；
- `useCatData({ fetch: false })` 是否确实不会让叶子组件发起 I/O，且根级 loader 覆盖所有 Console 页面；
- 保留 raw `catId` 的位置是否都是成员配置、诊断事实或未知值 fallback，而不是遗漏的人类可见展示。

## Open Questions

### 技术 OQ（给 reviewer）

1. passive roster subscription 与 root-owned fetch 的生命周期是否可靠，尤其是冷启动和 roster refresh？
2. Queue、toast、system info、Hub/mission control/community/story-private 等广泛投影是否都只改变 rendered copy？
3. `友好名称 · catId` 的 technical label 边界是否足够克制，是否仍有应该改为纯友好名称的普通界面？

### 价值 OQ（给 operator，如有）

无。

## Next Action

请 Fable 独立复跑定向测试并审查完整 diff。若无 P1/P2，请明确 `APPROVE`；若需退回，请为每个 finding 标注 P1/P2/P3、精确文件/行号和证据。

## Review Sandbox（必填）

- Path: `/tmp/cat-cafe-review/issue-1180-member-identity/fable`
- Start command: `pnpm review:start --web-port=5120 --api-port=3120`
- Ports: `web=5120`, `api=3120`；使用 review launcher 的 memory store，不访问 runtime 端口或数据。
- 沙盒必须保持 detached HEAD / read-only；如需改代码，请走 TAKEOVER 并另开正式 worktree。

## 自检证据

### Spec 合规

- Queue A2A caller/target 与等待原因已走统一 runtime roster resolver。
- Console 非成员配置位置已完成同类扫描并批量统一；成员编辑器/raw config fields 未改。
- 数据、API payload、routing、filter、persistence 仍以 `catId` 为唯一身份键。
- public Story Export 匿名化未接入 runtime display name。

### 测试结果

- 相关定向回归：162 assertions passed，覆盖 formatter、Queue、passive cache、toast、system info、authorization、artifact、navigator、execution label。
- `pnpm --filter @cat-cafe/web typecheck`: passed。
- `pnpm --filter @cat-cafe/web build`: passed（最终代码复跑两次）。
- `pnpm gate`: passed；16,603 public tests passed、0 failed、28 skipped；build/tsc/Web lint/repository check 全部通过。
- Web 全量私有 suite：5,057 passed、21 failed；21 项与改动前基线完全相同，分布在 chat governance refetch、F232 fixtures、SkillsContent、ThreadSidebar organizer、adaptive-pass-ball punctuation，未新增失败。
- `git diff --check origin/main...HEAD`: passed。

### 浏览器证据

- 作者在隔离实例 Web 5102 / API 3102 上通过 Hub Browser 打开 Console，`/api/cats` 成功加载 runtime roster；未访问保留运行时端口。
- 未通过真实猫调用制造 Queue 数据，避免副作用；Queue DOM 的 caller→target 与 wait-reason 投影由组件回归精确覆盖。Issue #1180 附图保留修复前证据，请 reviewer 在独立沙盒中做修复后视觉复核。

### 相关文档

- Issue: https://github.com/zts212653/clowder-ai/issues/1180
- Architecture map delta: none
- Implementation commit: `eb645aeec172d7d663914ed69c685b7257e4db84`

[砚砚/gpt-5.6-sol🐾]
