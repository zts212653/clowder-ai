---
feature_ids: [F202]
topics: [plugin-framework, train-c1, assessment]
doc_kind: plan
created: 2026-09-21
architecture-cell: plugin
---

# F202 C1 — 诚实评估与最短可行路径

> **已被取代（2026-09-21）：决策入口改为 `2026-09-21-f202-c1-contract.md`。** 本文仅作推导过程存档。
>
> ~~决策入口看本文。~~`2026-09-21-f202-c1-convergence-worklist.md`（1,055 行）是推导过程存档，
> **其中多处结论已被后续证据推翻，不要拿它做决策依据。**

## 一、唯一重要的那个事实

**`packages/api/src/domains/plugin` 有 18,254 行实现，至今没有任何一个插件能被激活。**

不是"差一点"——是 `module-plugin-runtime.ts:44` 自己写着 *"Loading is done here; activation is not."*
已装的唯一 `@clowder-ai/*` 插件（feishu-meeting-intake）是 stdio，根本不走 module 载体。

每一层都在加保证（完整性校验 / revision fence / 权限栅栏 / lease / 冻结 wire 表 / 双向校验），
**没有一层交付功能**。这就是 operator 说的"漂亮的空架子"，数字支持这个判断。

## 二、哪里退是合理的（逐条带证据）

### R-1 · 退掉 feature 这一维度 —— 强烈建议

**证据**：插件仓 14 个包，**每个恰好 1 个 feature**，`companion` 是 0。
**没有任何一个包用到多 feature。**

但 Host 与 SDK 为这一维度付出了全套代价：per-feature `FeatureContext`、per-feature
`activate`、per-feature action 表、per-feature `dispose`、`FeatureBinding` 里的
`featureId`/`activationRevision`/`grantRevision`、`context.featureId !== featureId` 校验……

VSCode 是**插件级** `activate(context)`，没有这一层。
**退到插件级激活，能删掉一整个维度的复杂度，而不损失任何已在使用的能力。**

> 反对意见需要回答：哪个真实插件需要"只启用一部分功能"？目前一个都没有。

### R-2 · 退掉（或降级）actions ↔ manifest 的严格双向校验 —— 建议

`activateDefinedFeature` 要求声明与实现一一对应：多一个报 `undeclared`，少一个报 `missing`。

**我先前说这"比 VSCode 更严所以更好"，这句没有论据，而且大概率是错的。**
正确论据是反向的：**这条校验换走了 lazy activation。**
VSCode 的 `activationEvents` 懒加载是它装 50 个插件还能秒开的原因；
要求 activate 时就产出全部声明的 handler，等于强制 eager、all-or-nothing。

**退法**：保留"不能暴露未声明的方法"（安全相关），去掉"声明了必须立刻实现"（换回懒加载）。

### R-3 · 不退：12 类 contribution

**我原本要建议砍到 4 类，证据不支持，收回。**
14 个包实际在用 **9 类**：identity · message-subscription · webhook · connector ·
content-editor-provider · schedule · mcp · limb · skill。只有 tool / service / ui 空着。

### R-4 · 退掉四套 yaml 里的重复

元数据 + 配置字段有 **3 套**解析（`plugin-manifest.ts` 351 行 / `im-connector-manifest.ts` /
`package-staging.ts` 234 行），字段名还不一样（`envName,label,sensitive,required`
vs `key,label,kind,required`）。`connector.yaml` 与 main `plugin.yaml` 几乎同形，先合这两套。

## 三、哪里不清楚（不要假装清楚）

1. **插件仓没有可信终态制品。** 工作区脏，`plugin-sdk/package.json` 有 2 处冲突标记，
   `wire-dispatch` 正从 sdk 搬向 contract（改到一半被暂停）。提交态 Telegram 调用了
   提交态 `FeatureContext` 里不存在的 `context.connectors.deliver`。
   → **现在不能升 Host 的 SDK pin，会把一个半成品钉死。**
2. **`GitHubOperationPort.run()` 由谁实现没有定论。** 写在 Host 违反
   "delete provider-specific Core implementations"；写在包里则 7 个 operation body 要先搬家。
3. **lazy activation 要不要**（见 R-2）。这是产品体验决策，不是实现细节。

## 四、怎么做：让"一个插件真的跑起来"的最短路径

> **2026-09-21 复核修正（宪宪/opus）。** 本节原内容（调 `activate` 拿 handler 表 +
> 改 `module-host-invocation.ts:31`）已被一手证据推翻。下面是复核后的版本，
> 原路径错在哪记在本节末尾供追溯。

### 一手证据：RED 测试到底卡在哪

`packages/api/test/f202-c1-installed-skill-activation.test.js`（0f7c62983）实跑：

```
✖ enabling a locally installed package registers its declared skill capability
  AssertionError: a skill declared by an enabled installed package must be
  present in Host capabilities        ← test.js:87
```

**失败点是第 87 行，第 73–84 行全部通过：**

| 行 | 断言 | 结果 |
|----|------|------|
| 73 | `manager.install({ local-directory })` | 通过 |
| 75 | `actions.setEnabled === true` | 通过 |
| 76 | `manager.setEnabled({ enabled: true })` | 通过 |
| 83 | `activationState === 'enabled'` | 通过 |
| 84 | `runtimeState === 'healthy'` | 通过 |
| 87 | skill 进入 Host capabilities | **失败** |

装包 / 完整性校验 / 生命周期 / 健康态**全都是通的**。
缺的只有最后一跳：**声明的 contribution 从未被注册进 capabilities。**

### 真正的缺口：不是"实现激活"，是"接线"

- **新路径**：`plugin-manager-service.ts:272` → `lifecycle.setEnabled(...)` → 到此为止。
  **没有任何一步走向 capability 注册。**
- **老路径**：`PluginResourceActivator.ts`（1,023 行）**已经完整实现了 skill 注册**——
  解析资源目录 → 校验在根内 → 校验 SKILL.md 存在 → `addSkill()` → 写 capabilities
  （带 `pluginId` / `enabled`）。
- 这 1,023 行**只在 `index.ts:4366` 被构造一次**（老 bootstrap）。新 Manager 从不碰它。

### 形状差（唯一的真实工作量）

| | 契约（新） | 老 activator |
|---|---|---|
| 入口 | `manifest.contributions: StaticContribution[]` | `manifest.resources: PluginResourceDef[]` |
| skill 项 | `{ type:'skill', id, path }` | `{ type:'skill', name?, path? }` |

skill 近乎 1:1（`id` → `name`）。老 activator 覆盖 skill / limb / mcp / schedule 四类，
正是契约 12 类里**需要在 Host 侧落地资源**的那四类。

### 修正后的最短路径

```
1. 在 Manager 生命周期 enable/disable 上接出 contribution 注册钩子。
2. 写 contract contributions[] → PluginResourceDef[] 映射（先只做 skill）。
3. 复用已有的 PluginResourceActivator，不新写注册逻辑。
4. 验收：上述 RED 转绿。
5. 然后才谈 schedule / limb 白名单、yaml 合并、17,595 行删除。
```

**不要在第 4 步绿之前做第 5 步的任何一项。**

### 这条路径不依赖 R-1 —— 承重结论

契约里 `path` **只存在于插件级** `StaticContribution`；feature 级的
`ContributionReference` 是 `{ type, id }`，**没有 path**
（`contract.generated.d.ts:54-61`，beta.15）。

所以任何资源注册桥**必须**读插件级 `contributions[]`。R-1 只决定要不要再按
已启用 feature 的 id 引用过滤一层：

- R-1 退到插件级 → 注册全部插件级 contributions
- R-1 保留 feature 级 → 同样的解析 + 一层 id 过滤

**两种结局下解析代码相同。第 1–4 步不会因 R-1 的任何一种结论而白写。**
原文"前提：先定 R-1，这一条不定，写什么都可能白写"——**不成立**。

### 原文错在哪（追溯）

- 原 step 1「enable 后调包的 `activate` 拿 handler 表」：RED fixture 的 `create()` 返回
  `{ manifest }`，**根本没有 `activate()`**，却已经跑到 `runtimeState: healthy`。
  这一步不碰那条失败断言。
- 原 step 2「改 `module-host-invocation.ts:31` 的方法解析」：该文件是
  `HostMessagingDeliveryPort`，解析的是 `host.messaging.deliver`，
  **skill 测试全程不经过它**。（另：原文路径少了 `builtin-runtime/` 段。）

## 五、给接手者：这份文档哪里不能信

写这份文档的是 opus，在同一个 session 里**连续给出并推翻了四个方向**
（不该造适配器 → 插件仓是总闸 → 删掉 C1 → 往 main 4 类收敛），
每次都是被最后说话的人纠正，而不是自己先验证。operator 已明确表示不再信任其判断。

**2026-09-21 复核已执行（宪宪/opus），三项逐条结论：**

| 原断言 | 复核结论 | 证据 |
|--------|----------|------|
| R-1：每个包恰好 1 个 feature | **成立** | 13 个 `plugin.yaml` 各 1 个 `- id:`，+ `companion` 0 = 14 包 |
| `domains/plugin` 18,254 行 | **量级成立，数字偏高** | 实测 **18,063** 行 / 93 个 `.ts` |
| 第四节第 1、2 步是最短路径 | **推翻** | RED 实跑停在 test.js:87，前序断言全绿；见第四节 |

第三项是本文原先唯一未经外部证据交叉验证的部分，复核结果是**错的**，第四节已整节重写。
前两项可继续引用。

**已被推翻、不要再引用的旧结论**：见 worklist §0.0–§0.05 各节自带的作废标记。
