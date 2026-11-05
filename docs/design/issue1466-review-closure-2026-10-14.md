---
feature_ids: [F320]
topics: [onboarding, member-configuration, compatibility]
doc_kind: implementation-plan
created: 2026-10-14
tips_exempt: Existing native runtime configuration tip covers this refinement; no new onboarding concept is introduced.
---

# #1466 / PR #1519：review 收敛与成员列表整改

本轮沿 `feat/onboarding-first-run` 实施，已先合流 main `449134fed`，再合流新发布的 `69d968d99c898d4287e994383fd60e2be583c0b3`。
目标是让首次创建简单、列表清晰，并补齐 reviewer 已指出的运行时与升级边界。生产环境和持久数据不重置。

## 旅程与边界

用户从首页进入自动协作演示，右侧成果逐步完善；完成后进入本机伙伴推荐，按实际发现的客户端一键创建。
Mock 演示不依赖安装、认证和模型产出速度；正式伙伴的安装、登录、连接成功分别表达。
默认模型与强度继续跟随工具，支持 OAuth 和 API Key，不强制某种认证方式。
Codex App Server、Claude 原生客户端、DSH ACP 的 descriptor 与账号配置保持各自语义。

## 创建身份与兼容

1. 新推荐成员使用 main 的 `autoSlug` 规则，按运行工具标签得到 `codex`、`claude-code`、`dsh`；占用时保留长度并加序号。
2. 已存在、停用、保留身份进入命名空间检查；别名独立规范化和去重；不同 ACP 完整 descriptor 独立推荐。
3. 初次分配后保存到原 v2 草稿。重新探测、改名、普通网络错误不会重算 ID。旧长 ID 草稿保留原 ID 和自定义账号/参数。
4. 服务端将 operator、journey、partner 请求计算为归属摘要，同时保存规范化完整请求的摘要。
5. 创建回执存于角色 variant，复用 catalog mutation/file lock 和一次临时文件 rename；不另建回执文件或存储 authority。
6. 同一请求并发或响应丢失后的重试返回原成员；不同请求占用相同短名会在持锁期间分配序号。同一请求改变配置返回 409。
7. 重放不能提前返回：权限继承、registry reconciliation、配置发布仍执行，可恢复“已落盘、发布中断”。
8. 已提交但没有旧回执的草稿不能凭 ID 认领。若发现对应旧伙伴，提供用户明确点击的复用入口。存量 ID、关系引用、账户和历史消息不迁移。
9. ACP 的本地相等判断和伙伴索引使用完整 command / startupArgs / transport 描述，短散列只用于旧角色查询。新创建请求使用先持久化的 128 位随机 token，避免完整参数编码后超过请求头限制；服务端仍以完整 payloadHash 校验。旧 short-v1 pending 草稿保留原请求 key 和完整 body，响应丢失后的升级重试不会换归属。独立 review 提供的真实散列碰撞 `1e1unfl` / `hlxo45` 已加入“两伙伴均创建、分别恢复”的反例。
10. 旧草稿的 existingId 必须仍在当前 roster 且 descriptor 一致；已删除成员提示确认重新创建，不能凭本地旧 existingId 回报成功。
11. 保留的 goal 路径也读取当前真实 roster 并执行相同的完整 descriptor 校验。旧碰撞 created 回执只恢复其匹配的成员；另一 descriptor 保留原表单，使用独立新请求创建，不能重放已明确归属第一份配置的旧请求键。安装包验证单列，不由源码或同进程 Fastify 重建冒充进程重启验收。

Architecture cell: identity-session（现有 runtime catalog owner）。Map delta: none。
原因：内部 variant 增加归属元数据，写入与恢复仍由原 owner 负责，没有平行 store/queue 或新授权面。

```mermaid
flowchart LR
  A[推荐工具并保存草稿 ID] --> B[用户确认创建]
  B --> C[服务端生成请求归属与完整配置摘要]
  C --> D[Catalog mutation + file lock]
  D --> E{已有同一回执?}
  E -->|配置相同| F[恢复原成员 ID]
  E -->|配置不同| G[409 配置冲突]
  E -->|没有| H[检查命名空间并分配 ID / 别名]
  H --> I[角色与回执一次原子落盘]
  I --> J[权限继承 / registry / 发布]
  F --> J
  J --> K[保存实际 ID 与创建结果]
```

## 列表与连接管理

成员列表主行保留昵称、家族、模型、传输、状态、@ 名字和开关；ID 从主行移入配置详情。
固定列宽、单行省略、统一顶端对齐；窄容器可横向滚动，筛选、键盘排序、默认成员、开关继续可达。
完整 ID、模型、账号可展开和复制，状态解释可键盘展开；复制失败明确提示，仍可选择原文。
Codex 行内账户控件对齐最新 main 的只读摘要，修改通过成员编辑和连接管理；保留 accountBindingMode、显式账户、自定义参数和 ACP。

## Reviewer 反馈映射

| 反馈 | 实施与验收 |
| --- | --- |
| 默认 CLI readiness 不能代表显式账户或自定义参数 | 推荐、列表、编辑共用默认身份适用性判断，configured / login_required 两个方向均有反例与普通默认身份对照 |
| authenticated 探测测试不能调用真实 CLI | 自带假 Codex JSON-RPC 与假 Claude auth status；只允许指定启动计划、归属 PID 的 Windows 清理和 Unix 只读进程扫描；检查脱敏与 refreshToken=false |
| macOS xpcproxy → Node 身份转换 | 保留 PID 出生时间、job/PID 与精确命令约束；增加 native macOS CI 和测试程序 witness，原生生命周期未通过前不能关闭 |
| 最新 main 冲突 / CI | 保留 configurationSource 与 accountBindingMode 两套语义；修正 Web 清单锁文件、按钮合同、Windows Node 构建入口和重复 CLAUDE_CONFIG_DIR 注册 |
| 短 ID 不能只按名称判幂等 | 同 catalog 持久归属、并发、发布中断恢复、旧草稿恢复；完整 descriptor 保留，不从短 ID 推断 adapter 或认证 |

本轮不是 #1466 全 Feature 关闭声明，也不是合入许可。安装/认证恢复、F229/F320 完整验收、DSH 生命周期以及既有真实调用证据仍按原讨论分别对账；已修 ACP 历史缺陷不重开。

原生 witness 进一步确认 BSD ps 将换行显示成 `\012`。launchd lease 的子命令使用单行 base64url JSON 传输，runner 校验并解码后原样 spawn；停止仍按精确命令、出生时间和 job/PID 验证。多行、制表、回车、Unicode 和 shell 字面量参数有真实子进程检查。main 中非 macOS 路径引用了已删除的 captureIdentity，已恢复并加入 Windows/Unix 真实启动检查。
macOS CI 显式安装全局 pnpm、Bash 和 Redis；测试保持私有 HOME、真实 Redis 保存和清理失败不能认证成功的合同。夹具的协作清理遵从正式 start-dev.sh 的屏蔽重复信号规则；已 unref 的测试进程等待退出前重新 ref，避免 Node 提前结束事件循环。
stop fixture 统一调用生产公开的 readProcessIdentity，保持 UTC/C locale 和完整 ps 宽度；CI 再以 America/Los_Angeles 验证，产品的 PID、出生时间和命令保护不放宽。

列表作者浏览器证据（源码延续证明：之后的修复未修改列表展示组件）：

![成员列表](assets/issue1466-members-20261014/desktop.png)
![完整配置与复制](assets/issue1466-members-20261014/details.png)
![窄屏横向滚动](assets/issue1466-members-20261014/narrow.png)

## 验证与部署

### Windows 安装版验收增量

用户 2026-10-14 补充要求验证真实 Setup.exe：安装、首次空角色引导、推荐创建、正式回复和重启后的历史。现有 Electron 固定生产端口，直接执行会复用生产 Redis，不能作为隔离验收。

- 显式 `CAT_CAFE_DESKTOP_INSTANCE_ROOT` 启用独立实例，并要求三个合法、不同且非生产的端口。普通桌面启动的端口和目录保持原默认值。
- ServiceManager 仍是进程 owner；隔离启动拒绝已占用端口，要求独立持久 Redis，不静默降级内存。配置、global owner、消息、Electron userData 和 cookie 分开，禁止导入宿主历史。
- 隔离子进程只继承操作系统启动必需变量，重新构造私有 HOME/CLI 配置目录和服务参数；外部 WORLD_DB、TASK_OUTCOME_DB、GLOBAL_KNOWLEDGE_DB、认证变量与 MEMORY_STORE 不继承。污染哨兵通过真实自有 Node 子进程验证，不访问对应数据库。
- 安装版浏览器经只读 preload 取得实际本机 API 地址；隔离 Web gateway 接管 API、Socket.IO 和 uploads，避免正式 Next 构建内的旧端口 rewrite 触及生产。SSR 使用实际 API_SERVER_PORT。
- 安装器允许独立 AppId、显式 UserProfileRoot、禁自动启动和禁桌面快捷方式的命令行参数，便于真实安装而不覆盖已有注册项、CLI hooks 或快捷方式。没有这些参数的普通安装默认行为保持不变。
- 依赖沿官方 `pnpm deploy --prod --config.node-linker=hoisted` → Electron → tar → Inno Setup 管线生成，编译源码与 build stamp 对齐；不将 win-unpacked 或 CI installed-layout 测试称为已验安装包。
- 验收分别记录安装退出码/日志/关键文件、零角色首屏、自动 Mock A2A 与逐步预览、一键推荐创建后的 ID/descriptor、真实客户端回复、完整 OS 进程退出再启动后的角色/消息读回。CLI 状态探测和模型真实产出分开。

Architecture cell: desktop-bootstrap（现有 ServiceManager owner）。Map delta: none。隔离是显式配置的既有服务组合，没有第二份角色 authority 或平行记忆存储。

作者检查：受影响角色 CRUD / catalog / readiness / 创建重放回归；引导与成员前端回归；API/Web 类型与正式构建；Windows 包装器回归；原生 macOS lifecycle CI。
浏览器核验：列表长 ID 截断、完整值复制、键盘详情、编辑跳转、推荐创建与错误恢复；保留演示旅程。
部署使用新的独立 Next 构建和 deploy 目录，先记录角色、线程、消息与 catalog 摘要，再只切换隔离 Web 5152 / API 3152。
Redis 6366、HOME、角色 catalog、历史与 SQLite 路径延用原隔离实例；生产 3003 / 3004 / 6399 不操作。
启动后对照 build stamp、API 健康、Web 可达性和原数据回读。旧 deploy 保留用于回退。

## 最新 review 与真实 Windows 安装准备

- zts 6161387979：无 ACK 的旧 ACP 共享键迁移补充共享来源标记；唯一提交 descriptor 保留原 key/body，真实 POST 成功后为其他 descriptor 持久化独立键。explicit existingId 复用不充当服务端归属证明。members/goal、正常/反序探测、已提交丢 ACK/均未提交共 8 例 RED→GREEN。服务端完整 payloadHash 冲突约束保留。
- Windows PowerShell 5 入口使用 ASCII 脚本兼容；8.3 TEMP 与长路径 fixture 按 realpath 校验同一目录。preload VM 注入真实契约所需 argv；main 实例初始化/重定向与日志职责归入 runtime-config，main 343 行。
- 新冻结出口改用普通 pnpm 9 install --prod --frozen-lockfile --config.node-linker=hoisted。hoisted deploy 会关闭锁读取，不能通过 frozen 参数补救。源码只复制 Git 跟踪清单及显式编译 dist；不复制本地 data/.env/uploads 等运行私有文件。导出按完整包单位处理私有覆盖，保留嵌套 peer，不递归叠加旧包残留。
- hoisted rebuild 未执行原生依赖 hook，新增按锁定 registry 包执行 install hooks；workspace prepare 仍属于源码构建阶段。新导出 API 用 Node 24 ABI137 执行 SQLite SELECT1 已成功，OTel2.6.1、ClaudeSDK0.3.285 与源锁一致。正式安装器、首次首屏、创建、模型回复与完整进程重启验收尚在进行，不能用上述包级检查替代。
- 当前本轮引导回归 16 文件 86 项，桌面受影响回归 82 项通过；Web TypeScript noEmit 通过。最终 HEAD CI、实际 Setup.exe 全旅程和源码隔离环境重启将在实证完成后补齐。

## 最新安装与兼容反馈（2026-10-14）

- zts 6162292490：旧共享请求键的归属不能由 roster 同名/同 descriptor 推导。现在保留原 key/body，只有成功的原请求重放才拆分其他 descriptor；新增 members/goal × 正反探测顺序，服务端实际分配 dsh-3、另一个 journey 占用 dsh-2 的 4 条回归。原 8 条恢复继续通过。
- 同条 macOS 路径 P1：原生 hook 遍历前 canonicalize workspace；自有目录 alias 与真实外部依赖拒绝同时覆盖。Windows junction 实测通过，macOS 交由原生 CI 验证。
- mind 6161659038：second-instance 协调退出核验安装目录和 Electron userData 身份；安装/升级/卸载共用按安装目录界限过滤的停机脚本，撤掉全局进程名停机。显式隔离根/3 端口写入安装 sidecar，环境为空时仍恢复隔离身份；缺失/损坏身份不回落生产端口。普通安装保留默认值。
- 桌面测试首次 require 前设置 HOME/USERPROFILE/LOCALAPPDATA/APPDATA 私有根，恢复环境；日志根副作用也在夹具内。
- d4d50 的 Windows 路径身份与 Public 静态构建检查已通过对应远端 CI；最新代码还需整组 CI。
- 真实 Windows BSD tar 在 @fastify/send 发布的 snowman 测试目录上崩溃/解包失败。冻结出口仅排除该包测试目录，保留生产入口/lib/types；GNU 生成的归档已用系统 tar 解包并验证 SQLite。真实 Setup 安装和完整 UI/模型旅程继续取证，不以归档或 fixture 检查替代。
独立复核补充：升级 helper 改用旧版本不会匹配的 --quit-owned-installation，且只向支持新身份模块的版本请求协调退出；旧版本走限定安装目录的清理。Windows 通过文件句柄 canonicalize AppDir 和进程 executable，覆盖 junction/短路径。同安装＋同实例新请求、另一安装/实例及旧接收者控制、真实目录/别名/兄弟进程回归通过。
