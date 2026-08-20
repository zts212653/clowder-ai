---
name: owner-friendly-plugin-development
description: >
  把真实用户旅程转成可安装、可授权、状态诚实、可恢复的 Clowder AI 插件产品边界。
  Use when: 设计或开发需要 Settings 安装/授权、后台 runtime、事件或数据入站、Needs Me、Host 路由的插件。
  Not for: 只搭 Codex 插件目录（用 plugin-creator）、纯 skill/MCP、无宿主生命周期的一次性 API 脚本、只修插件内部实现 bug。
  Output: 用户旅程契约 + ownership/authority map + 生命周期/恢复/发布方案 + fresh-consumer 与真实 dogfood 证据。
triggers:
  - "开发插件"
  - "设计插件"
  - "operator友好的 plugin"
  - "owner-friendly plugin"
  - "设计插件授权流"
  - "插件生命周期设计"
  - "插件发布闭包"
  - "插件 dogfood"
not_for:
  - "搭 Codex 插件目录"
  - "纯 skill 或 MCP"
  - "一次性 API 脚本"
  - "插件内部 bug fix"
output: "Journey contract + ownership/authority map + lifecycle/recovery/release plan + fresh-consumer and real-dogfood evidence"
---

# Owner-Friendly Plugin Development

插件“装上了”不是终态。终态是：operator少做了一段机械劳动，同时仍看得懂系统正在做什么、为什么停了、怎样恢复，并且只在真正需要判断时被打扰。

## 为什么这是一个 Skill

F292 实战连续暴露了通用模型不容易从普通插件教程中得到的边界：公开契约与宿主权威必须分仓但不分叉；monorepo 能掩盖发布包缺依赖；`enabled` 不能冒充进程健康；认证与修复不能把裸命令甩给用户；真实效用只能由完整旅程证明。具体证据见 [F292 case study](refs/f292-case-study.md)。

## 使用边界

- **Use**：插件跨越 Settings 安装/授权、受监管 runtime、外部事件或数据、Host 路由、Needs Me 或持久用户状态。
- **Not for**：已有插件怎么配置（`guide-interaction`）、搭 Codex plugin bundle（`plugin-creator`）、纯 skill/MCP、一次性 API 脚本、已知内部 bug（`debugging`）。
- **灰例**：无后台生命周期的无状态 transformer，通常只需现有 contract + `tdd`；只有它仍改变完整用户旅程或 authority boundary 时才加载本 skill。

## 1. 先冻结被删掉的人类劳动

先写一行 before / after，不先列 SDK 能力：

```text
Before: 人找产物 → 下载/复制 → 找目标 → 补背景 → 请求处理
After: 产物自动出现 → 人只补机器不知道的判断 → 结果回到正确目标
```

同时冻结三件事：

- **终点**：用户少做了哪几步，而不是系统多了哪些模块。
- **人类保留权**：身份映射、缺失背景、目标、敏感授权等哪些选择必须由人确认。
- **Non-goals**：不顺手造新的总结器、事件总线、记忆副本或双向写回面。

设计前读现有插件 contract、catalog/registry、相邻长期集成和 ownership map。已有公共坐标就扩展它；不要在 Host 私造同义 resource，再安排一次迁移。

## 2. 画清 truth、authority 与 custody

| 角色 | 应拥有 | 不应拥有 |
|---|---|---|
| 外部来源 | 原始数据、供应商身份与凭据真相 | Clowder AI 目标、猫、线程与家庭记忆 |
| 插件 | 来源适配、声明的 capability、有界 observation/source ref、cursor/reconnect | Host 路由、用户工作流真相、整份私密正文的事件副本 |
| Host | 安装/SRI/grant、进程生命周期、持久状态、去重、目标与注意力策略 | 供应商原始内容的第二真相源 |
| 猫 | 授权后读取来源、结合家庭上下文解释与产出 | 借 prompt 内容提升权限或改变路由 |
| operator | 不可推断的背景、授权、去向与最终取舍 | 搬文件、抄 token、判断隐藏进程是否还活着 |

跨边界优先传 bounded metadata + opaque source ref；大正文、secret、家庭记忆和目标句柄各留在自己的 authority domain。插件只报告 observation，不替 Host 作处置决定。

## 3. 把生命周期拆成五份真相

不要用一个 `enabled` 包打天下：

```text
artifact: installed / verified / version
config:   incomplete / ready / invalid
auth:     disconnected / pending / connected / expired
intent:   disabled / enabled
live:     dormant / starting / running / degraded / crashed / stopped
```

关键规则：

- 安装、启动、授权是三件事；安装与 API boot 默认不得偷偷启动外部进程。
- `enable` 前实时验证 auth，不用缓存的 `connected` 猜测。
- 进程退出立即投影 `crashed` 或 `stopped`；重启若按契约 dormant，就诚实显示 dormant，不能保留“运行中”。
- timeout、abort、shutdown、输出上限与进程树清理都属于监督契约。
- 用户卡片同时展示“想让它运行吗”和“它现在真的在运行吗”，并给下一步动作。

## 4. 授权和恢复必须留在产品里

插件卡片是 setup、auth、health、repair 的唯一入口；不要让用户复制终端命令或裸 argv。

- Host 只启动 catalog 声明且完整性验证过的 runner；不接受第三方 manifest 自带任意命令面。
- 设备授权只允许供应商固定域名，opaque device secret 留在服务端，页面只显示验证 URL、用户码或 QR。
- 凭据留在既定用户凭据库；Host child env 使用 allowlist，不把 secret 变成插件环境变量。
- regrant、retry、manual import 都回到同一持久记录，不新造第二条流程。
- 每个 degraded state 都配一个具体动作；不能只给“发生错误”。

## 5. 保护operator的注意力

成功的后台工作应保持安静。Needs Me 只接两类东西：

1. 机器无法可靠决定的用户判断；
2. 需要用户动作才能恢复的失败。

同一来源的 redelivery/restart 必须 reconcile 到同一 durable record。用户可见工作流状态默认持久化；去重是“一个来源一个可见对象”，不是静默丢弃证据。

## 6. 发布的是运行闭包，不是源码幻觉

发布前从最终 packed artifact 证明：

- catalog pin、manifest、入口文件与 SRI 指向同一不可变字节；
- runtime 依赖在一个空白 consumer 中可解析，不能借 monorepo hoisting、全局安装或 symlink 假绿；
- 解包后的物理成员、入口启动和关键子命令都从发布物运行；
- PR CI 只验证候选，正式 publish 只由受保护分支与最小权限 workflow 触发；
- upgrade/rollback/uninstall 明确哪些配置、凭据和 durable user state 被保留或撤销。

## 7. 按 claim 选择证据

| Claim | 机制 | 完成证据 |
|---|---|---|
| schema、权限、路由、payload 边界 | test / conformance / guard | hostile fixtures 与契约检查绿 |
| 进程、重连、耗时、稳定性 | logs / metrics / typed state | restart/crash/auth-loss drill 的真实投影 |
| “真的帮用户省事” | real dogfood | before 中的机械步骤在完整旅程里消失 |
| 是否保留某条智能推荐 | eval（有 consumer 与 keep/tune/sunset） | 有决策用途的 verdict，不用 CI 代替 |

不要给整个插件贴一个“已测试”标签；逐条 claim 选择机制。完整 dogfood 至少覆盖 discovery → setup → auth → explicit enable → live work → attention/recovery → upgrade/uninstall 中与本插件有关的环节。

## 完成门

- [ ] Before/After 旅程由用户能感知的劳动变化定义。
- [ ] ownership map 没有重叠真相源；插件不能选择 Host 目标。
- [ ] installed/config/auth/intent/live 分开，所有失败状态诚实且可修复。
- [ ] 授权、regrant、诊断从产品入口完成，不要求用户抄命令。
- [ ] packed artifact 在 fresh consumer 中可运行，exact bytes 与发布 provenance 可追。
- [ ] 契约 claim、运行健康 claim、效用 claim 各有匹配证据。
- [ ] 至少一条真实旅程证明机械步骤消失；未 dogfood 就不能宣称产品完成。

## Common Mistakes

| 错误 | 后果 | 修复 |
|---|---|---|
| 从 manifest 能力出发，不从用户摩擦出发 | 做出“能装但没省事”的插件 | 先冻结 Before/After 与人类保留权 |
| 让插件携带正文、目标或家庭上下文 | 隐私外溢、authority 逃逸 | bounded observation + source ref；Host 路由 |
| 在 monorepo 里直接跑入口就算发布验证 | hoisted 依赖掩盖坏包 | packed artifact + empty consumer |
| 用 `enabled`/“正在启动”遮住 crash 或 restart dormancy | 用户无法判断是否工作 | intent 与 live truth 分离，退出立即翻状态 |
| regrant 展示裸命令 | 把内部命令面和故障处理甩给用户 | 卡片内受限授权 action |
| 每条事件都进 Needs Me | 注意力收件箱退化成日志流 | 只投 unresolved judgment / repair |
| CI 全绿就宣布好用 | 证明了契约，不证明了效用 | 跑真实 dogfood，记录被删掉的人工步骤 |

## 和其他 Skill 的区别

- `plugin-creator`：搭 Codex plugin bundle；本 skill 设计有 Host 生命周期与用户旅程的产品插件。
- `console-dev`：落实 Settings/卡片 UI；本 skill 先定义入口、状态与权威。
- `writing-plans` / `tdd`：拆实现并保护行为；本 skill 给它们 journey、state 与 claim contract。
- `opensource-ops`：处理公共仓 issue/PR；本 skill 定义跨仓插件自身应交付什么。
- `quality-gate`：汇总交付证据；本 skill 定义插件特有的完成证据。

## 下一步

新产品能力先进入 `feat-lifecycle`；边界冻结后用 `writing-plans`，行为实现用 `tdd`，Settings 体验用 `console-dev`，公共仓交付用 `opensource-ops`，收口用 `quality-gate`。
