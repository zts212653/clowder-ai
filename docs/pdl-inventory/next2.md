# next2 — 设计 250a225 的 batch 1 绑定

未提交、未推送；未改 `.env`，未启停服务。只改应用与测试；后端未改。

## 分层与看得见的变化

- 引擎 / 组件 / 主题（PDL）：保留用户复制的内容，未编辑；65 个文件对设计 `250a225` 逐字节一致。
- 应用：继续 host push → held snapshot → VM；新增分页状态随现有 reviews 来源发布，不增加取数来源、定时器或接口。

| 项 | 结果与可见效果 | 应用落点 / 真实 owner |
| --- | --- | --- |
| T01 作品分页 | 已接 `hasMore/loadingMore/stale/moreError/load`、`groups[].last`；列表 `next` 调 `worksMore`，重新读取调 `worksRestart`。未读完不当作 stale；续读 / 失败保留已读作品。 | `useReviewBindings.tsx` → `useGlobalArtifacts({view:'works'})` → 既有 `usePagedGlobalWorks`（首屏一页，显式继续最多四页 / 24 个新作品）；`content-data.js`、`project.js`。 |
| T02 复制 Thread ID | 行已有原始 `id`，主题的新菜单直接调用引擎 `copy {v:@id}`；无需增加 handler 或接口。 | 真实侧栏行 → 通用平台 clipboard。运行时测试从真实菜单项复制 `pdl-test`。 |
| T05 所有者昵称 | 对话框给原始 `nickname`；仅与打开时的值不同时发送，清空发送 null。保留全部 handles，主题只显示第一项。 | `members.js`、`member-actions.ts` → PATCH `/api/config/co-creator`。 |
| T06 成员保存 | `form.save` 给 `state/error/pendingWrite`；失败在 Save 旁显示，保留表单。核对结果不明的写入后再决定是否补写；已确认的成员 revision 保留，附属设置失败只重试未完成阶段。保存中产生的新草稿不被清空。 | `members.js`、`PdlAppHost.tsx`、`member-actions.ts`；复用 `saveMemberRecord` / `saveMemberExtras`。两个 helper 只增加原始错误 code 的传递，核对与写入算法不变。 |
| T21 改投确认 | 现有 / 新对话都打开声明的 `routingRedirect`，原样交给对话框 unavailable / targets；确认沿用同一个 idempotency key 并加 confirmedTargetCats，取消保留草稿。 | `PdlAppHost.tsx` 的稳定 callback → `useSendMessage` / `useNewConversationAdmission` → 既有 POST `/api/messages`。 |
| 猫猫星球 | 删除 app 的 entry / frame / view 重复注册；只给 `starryFrame.src`、message 动作与生命周期。 | `starry.js`；主题 entry `builtin.starry`、frame key `starry`、view `builtin.starry`；同源 `/frames/starry` 及现有可信桥保持不变。 |
| 记忆读取更多 | 改给 `all.more = meta.hasMore`；失败 / 空数据时无 more。 | `owner-projections.js`；沿用真实 memory 来源。 |
| 所有者颜色 | 已核对，无需改绑定：`WHO_DATA.me()` 有 coCreator 原始 `{primary,secondary}`。 | `chat-models.ts` 的 `me`；运行时测试通过复制的 who.js 验证颜色。 |

## 验证

新增 / 更新的行为验证覆盖作品续读 / stale / continuation error、菜单复制 ID、昵称未改 / 修改 / 清空、保存按钮阶段与错误、创建回执丢失后的核对与避免重复创建、部分保存重试、原始路由确认、记忆 more、主题星球入口与 frame 生命周期。成员策略测试的假回执改为完整 CatData，仍验证失败保留策略草稿与原始 revision；星球测试改读主题拥有的声明。

```text
pnpm -C packages/web exec tsc --noEmit --incremental false
exit 0 (no output)

pnpm -C packages/web exec vitest run src/pdl
 Test Files  67 passed (67)
      Tests  663 passed (663)

pnpm -C packages/web exec vitest run src/hooks/__tests__/usePagedGlobalWorks-visible-pagination.test.tsx src/hooks/__tests__/usePagedGlobalWorks.test.tsx src/hooks/__tests__/usePagedGlobalWorks-source-refresh.test.tsx src/hooks/__tests__/useSendMessage-routing-confirmation.test.ts
 Test Files  4 passed (4)
      Tests  25 passed (25)

pnpm -C packages/web exec next lint --dir src/pdl
exit 0; 0 Error lines / 56 Warning lines
info  - Need to disable some ESLint rules? Learn more here: https://nextjs.org/docs/basic-features/eslint#disabling-rules

pnpm exec biome check <16 changed application/test source files>
Checked 16 files in 721ms. No fixes applied.
Found 974 warnings.
Found 106 infos.
exit 0

i18n references = 47; unique = 33; missing keys = 0
design 250a225: 65 files; byte diff = 0; missing = 0; extra = 0; mock/proto/local = 0
privacy-grep = 0
git diff --check: exit 0
```

语言键按 app 的静态 `tc` / `t:` / `{t:…}` 引用对已生成的主题语言包机械核对。privacy-grep 范围为 `public/pdl`、`public/pdl-app` 和非测试 `src/pdl`。未添加持久检查规则。首次 Biome 批量 `--write` 内部 panic，改用只格式化改动处后重新 check，原文最终结果如上；无关自动改写已撤回，未修改检查配置或降低规则。

## 未完成 / 需要决定

本轮无阻塞或新增缺口。未做真实浏览器验收；未启停实例。next1 其它主题缺口继续保留原审计记录。
