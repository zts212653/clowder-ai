---
feature_ids: []
topics: [issue-1466, settings, member-identity]
doc_kind: bug-report
created: 2026-10-12
tips_exempt: 修正既有名字编辑与展示的不一致，不新增需要发现或学习的能力。
---

# #1466 成员名字保存后的展示一致性

## 原问题与已接受的方案

用户修改布偶成员名字后，详情和默认伙伴选择器显示新名字，成员卡片却仍显示「布偶猫 · 宪宪」。
用户指出设置界面没有家族名称入口，也没有展示优先级说明，并授权按以下方案实施并更新 runtime：

- 名字作为成员列表、详情和选择器的主要名称。
- 昵称是可选的辅助称呼，不覆盖名字。
- 家族保留分类/分组用途，不覆盖当前成员名称。

## 根因证据

生产版本 `ceb7a3ee39f3804b15d574f18c02ca5dc5ea3920`：

- 2026-10-12 11:14:14（Asia/Shanghai）对 `/api/cats/opus-5` 的保存 trace 为
  `cb8975cc-6642-489b-a4c3-3c7dfa10056e`，修改字段为 `name`、`displayName`，HTTP 200；写盘26.42ms，保存及刷新409.6ms。
- 生产配置与 `/api/cats` 均返回 `displayName: 布偶猫 opus5-5`、`nickname: 宪宪`、`breedDisplayName: 布偶猫`。
- `HubMemberOverviewCard` 优先取 `breedDisplayName`，而选择器通过 `formatCatName` 取 `displayName`。
- 单成员家族与多成员家族的旧写入逻辑不同，使这一错误优先级表现不一致。

## 实施边界

复用现有 `formatCatName`，统一成员卡片与详情标题，沿用选择器已有的可选版本备注格式。
卡片的辅助信息区域明确显示「昵称：…」，空昵称不占位。
「名字」输入框读取 `displayName`，改名时仍沿用已有的 `name/displayName` 同步写入；历史上这两项不同的成员，
仅打开编辑器或修改昵称不会隐式改名。

不修改家族配置、ID、呼叫别名、认证、消息存储或后台保存协议，不需要数据迁移。
家族分组的标题继续使用家族名称；本修复只统一成员级显示。

Architecture cell: Settings / member identity presentation
Map delta: none
Why: 复用既有展示函数和保存链路，无新增服务、状态对象或持久化契约。

## 验证

- 新增 `member-name-consistency.test.tsx`，旧代码3项按目标断言失败，修复后转绿。
- 覆盖同家族/同昵称不同成员、保存改名后返回列表及重开详情、修改/清空昵称、历史name/displayName不同。
- 连同默认伙伴选择器、成员启用控件、runtime切换和名称格式化，共5套26项通过。
- Web TypeScript及改动文件Biome error级检查通过。
- 真实入口：`feat-onboarding-first-run` worktree，`http://localhost:5122/settings?s=members&shell=v2&lang=zh`。
  修改隔离成员名字为「布偶名称验证」、昵称为「昵称验证」，保存后返回列表；卡片与下拉均显示新名字，
  昵称出现在辅助区域，重开详情仍为新值，随后恢复原测试配置。
- 本机证据：`G:/AIwork/clowder-ai/artifacts/issue1466-member-name-fix-20261012/preview-renamed.png`。

生产交付须核对加载版本、现有配置、历史会话与消息；部署证据归档到同一工件目录。
