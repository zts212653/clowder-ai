---
topics: [agent-hooks, mcp, runtime, cpolar, drift]
doc_kind: bug-report
created: 2026-07-28
updated: 2026-07-28
tips_exempt:
  reason: Correctness and safety fixes for existing Agent Hook and Skill/MCP drift workflows; no new user-facing capability.
---

# Agent Hook runtime MCP root bug

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | Agent Hook 健康检查把当前 Clowder AI 项目的 6 个核心 `cat-cafe-*` MCP 报为 stale；直接同步会把它们当作 project orphan 删除。期望 runtime 模式使用持久工作区作为全局 MCP 基线。 |
| **2. 证据** | Runtime API PID 40025 运行于 commit `7f86fd208`；`getAgentHookStatus` 返回其余 6 类 configured、MCP `6 drift issues`。逐项检查为 6 个 `project-orphan`，而 runtime worktree 的 capabilities 中没有 MCP，持久工作区包含全部 6 个核心 MCP。 |
| **3. 根因** | `agent-hooks/health.ts` 直接使用 `resolveStartupProjectRoot()` 作为 MCP 全局根。在 runtime 模式该值是一次性二进制 worktree；它没有持久 MCP 配置。其他 MCP/Skills 路由会先用 `redirectRuntimeProjectPath()` 映射到 `CAT_CAFE_WORKSPACE_ROOT`，Agent Hook 健康检查遗漏了这一步。 |
| **4. 诊断策略** | 对照 `routes/mcp-drift.ts` 的工作实现；给 Agent Hook 全局根解析增加同样的 runtime→workspace 映射，并让检测与同步复用同一解析结果。 |
| **5. 超时策略** | 若根映射回归测试不能稳定复现，停止修改同步器，转而把根解析抽成可注入依赖后测试。 |
| **6. 预警策略** | 任何方案若需要复制 runtime `.cat-cafe/capabilities.json`、删除项目 MCP 或增加第二套配置真相源，立即停止。 |
| **7. 用户可见交互修正** | 七类健康状态应全部 configured；本机同步不会删除核心 MCP。远程 localhost 门禁保持不变。 |
| **8. 验收** | 新测试证明 runtime root 映射到持久 workspace；Agent Hook API 测试全绿；使用实际两套根目录复查 MCP drift 为 0，核心 MCP 数量保持 6。 |

### 补充诊断胶囊：未初始化项目 Drift 同步边界

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 历史项目目录缺少 `.cat-cafe` 时，单项目 Drift 页面仍展示同步入口，`POST /api/drift/resolve` 也会接受写入。期望未初始化项目只读，且服务端拒绝 Skill/MCP 同步。 |
| **2. 证据** | 精确 HEAD `2488428aa` 上，Skill 与 MCP resolve 对临时未初始化目录均返回 200；`DriftBanner` 忽略 check 响应中的 `initialized=false`。 |
| **3. 根因** | 全项目同步已过滤未初始化路径，但单项目共用组件和 resolve 写边界没有复用“显式项目必须已有 `.cat-cafe`”这一不变量。 |
| **4. 诊断策略** | 用临时目录分别调用 Skill/MCP resolve，并对共用 `DriftBanner` 注入 `initialized=false`，验证服务端与 UI 两层边界。 |
| **5. 超时策略** | 若两种 resolver 的根解析语义不同，停止抽象共用路径，分别验证解析后的 effective root 再收敛边界。 |
| **6. 预警策略** | 若修复需要创建 `.cat-cafe`、补默认配置或静默跳过写入，说明仍在掩盖未初始化状态，应维持显式 400。 |
| **7. 用户可见交互修正** | 未初始化历史项目仍可查看异常详情，但会显示初始化提示且不再提供同步按钮。 |
| **8. 验收** | API 回归验证 Skill/MCP 均返回 400 且不创建 `.cat-cafe`；前端回归验证 localhost 下也隐藏同步入口；完整门禁通过。 |

### 补充诊断胶囊：Capability 写权限的服务端权威性

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 页面 hostname 为 localhost 时，`useDriftSync` 会展示全部 Skill/MCP 写控件；但若请求带 forwarding headers 或 API 绑定非 loopback，服务端仍返回 403。期望 UI 与服务端使用同一个可写性判据。 |
| **2. 证据** | 精确 HEAD `97c4a716b` 上，客户端只检查 `window.location.hostname`；`isLocalCapabilityWriteRequest()` 还会检查 API bind host、socket peer、Host、Origin 和八类 proxy forwarding headers。 |
| **3. 根因** | `canSync` 在客户端重新实现了服务端安全策略的一个子集，形成第二个权限真相源；反向代理的同源 localhost 页面因此可误判为可写。 |
| **4. 诊断策略** | 用同一 `/api/drift/check` 请求验证 direct localhost、forwarded localhost 与 non-loopback API bind 三种状态，并让 Skill/MCP 共用 hook 只消费服务端返回值。 |
| **5. 超时策略** | 若 check 与 resolve 请求无法共享同一门禁函数，停止添加客户端例外，改为独立的权限探测端点并由服务端复用门禁。 |
| **6. 预警策略** | 若实现仍读取 `window.location`、复制 loopback host 列表或为不同控件分别探测，说明第二真相源尚未消除。 |
| **7. 用户可见交互修正** | 只要服务端判定当前请求不可写，Skill/MCP 页面立即进入完整只读态，不再出现点击后必然 403 的操作。 |
| **8. 验收** | API 回归覆盖三种权威状态；Web 回归证明 localhost hostname 不能覆盖服务端 `syncAllowed=false`，且 `syncAllowed=true` 时本地动作仍可用。 |

### 补充诊断胶囊：Capability 写权限探测生命周期

| 栏位 | 内容 |
|------|------|
| **1. 现象** | Capability 列表仍在加载时切到项目 Skill/MCP，页面可能永久隐藏本地写控件。期望标签页只控制完整 Drift 报告，不能阻止服务端写权限首次定案。 |
| **2. 证据** | 精确 HEAD `d1eef245c` 上，两个页面都在项目标签或列表 loading 时传入 `enabled=false`；`useDriftSync` 因此不发首次全局 check，`scopeDrift.global` 缺失使 `canSync` 永久为 false。 |
| **3. 根因** | `enabled` 同时承担“是否加载所有项目报告”和“是否解析全局写权限”两个生命周期不同的职责，标签页优化意外关闭了权限真相源。 |
| **4. 诊断策略** | 直接以 `enabled=false` 挂载共用 hook，验证仍只发一次 global check，并在服务端返回 `syncAllowed=true` 后开放写权限。 |
| **5. 超时策略** | 若初始 global check 与后续完整报告发生覆盖竞态，停止在消费者层加例外，拆分 hook 内的 authority/report generation。 |
| **6. 预警策略** | 若修复读取 `window.location`、在 Skill/MCP 两处复制探测逻辑或项目标签触发全部项目扫描，说明仍未分离职责。 |
| **7. 用户可见交互修正** | 本机用户即使在加载期间切换标签，也会在服务端确认后正常看到 Skill/MCP 写控件；远程仍保持只读。 |
| **8. 验收** | 共用 hook 回归证明 disabled report mode 仍解析 global `syncAllowed`，且不会请求项目范围；既有 Skill/MCP 只读与本地可写测试保持通过。 |

### 补充诊断胶囊：Agent Hook 初始化后刷新竞态

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 项目初始化完成后，Agent Hook 刷新可能继续显示初始化前的 400，直到用户再次刷新或重载页面。 |
| **2. 证据** | 精确 HEAD `d1eef245c` 上，`refresh()` 只清 cache；同项目 `inFlightStatus` 仍被 `readAgentHookStatus()` 复用。旧请求还会在新状态之后写回模块 cache 和 hook state。 |
| **3. 根因** | 模块缓存与组件状态都没有“最新请求获胜”的世代标识；cache invalidation 没有使在途请求失效，`.finally()` 也无条件清理共享请求槽。 |
| **4. 诊断策略** | 让初始化前 GET 保持 pending，触发 refresh 后先返回 configured，再返回旧 400；断言确实发出第二次 GET，最终 UI/cache 都保持 configured。并审计项目切换与 sync 的同类覆盖路径。 |
| **5. 超时策略** | 若单个 generation 无法同时保护 cache 与组件 state，停止追加布尔标志，统一所有 read/refresh/sync 走一个带 request id 的加载入口。 |
| **6. 预警策略** | 若修复只是把 `inFlightStatus=null`、只 await 旧请求或只保护 cache，旧结果仍可能覆盖 UI；必须同时保护共享状态和 hook state。 |
| **7. 用户可见交互修正** | 初始化完成立即以新请求复检，初始化前错误即使晚到也不会重新出现。 |
| **8. 验收** | Red→Green 竞态测试验证 refresh 强制新请求且旧响应无法覆盖；项目切换、缓存、400/403、sync 测试全绿。 |

### 补充诊断胶囊：Drift 读侧写权限必须复用完整授权门禁

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 直接 localhost 页面在会话失效或当前用户不是 owner 时仍显示 Skill/MCP 写控件；真正调用 resolve 才返回 401/403。期望 check 保持可读，但 `syncAllowed` 与 resolve 的认证、localhost、owner 判据完全一致。 |
| **2. 证据** | 精确 HEAD `c3f0b84dc` 上，`/api/drift/check` 仅调用 `isLocalCapabilityWriteRequest()`，而 `/api/drift/resolve` 依次调用 `resolveSessionUserId()`、localhost 门禁和 `resolveOwnerGate()`。 |
| **3. 根因** | 同一写权限被拆成两个不同真相源：check 只暴露网络局部判据，resolve 才执行完整授权；客户端无法区分“本机但未认证/非 owner”。 |
| **4. 诊断策略** | 抽取无副作用的统一授权评估函数；check 只读取 allowed 布尔值，resolve 再把同一评估结果映射为 HTTP 状态。 |
| **5. 超时策略** | 若读取端复用授权会改变 check 的 200 语义，停止复用 reply 写入逻辑，保留纯评估结果与响应映射两层。 |
| **6. 预警策略** | 若实现仍在 check 内单独判断 hostname、session 或 owner，说明权限第二真相源仍存在。 |
| **7. 用户可见交互修正** | 会话失效或非 owner 仍可查看异常，但所有写控件保持只读；本机有效 owner 的操作不受影响。 |
| **8. 验收** | API 回归覆盖无会话、非 owner、有效 owner、forwarded 和非 loopback bind；check 均保持可读并返回与 resolve 一致的 `syncAllowed`。 |

### 补充诊断胶囊：MCP 弹窗写权限异步定案

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 本机用户在写权限 check 尚未返回时打开外部 MCP，弹窗会永久停在只读状态；即使服务端随后返回 `syncAllowed=true`，也必须关闭重开才可编辑。 |
| **2. 证据** | 精确 HEAD `c3f0b84dc` 上，`handleCardClick()` 把当时的 `!driftSync.canSync` 写入 `modal.readOnly`；渲染时只把最新权限传给 `allowLocalActions`，没有重新计算 `readOnly`。 |
| **3. 根因** | 服务端权威权限的异步结果被错误地快照进弹窗状态；state 混合了 MCP 自身不可编辑属性与会变化的请求授权。 |
| **4. 诊断策略** | 弹窗 state 只保存 MCP 自身的只读属性；渲染时再与最新 `canSync` 合成最终 `readOnly`。 |
| **5. 超时策略** | 若 modal 内部初始化仍锁住旧 props，停止在父组件补 key，改为审计 modal effect 的依赖并保持同一实例响应 prop 更新。 |
| **6. 预警策略** | 任何把 `canSync` 再次写入 `useState`、或靠关闭重开恢复的方案，都说明权威状态仍被复制。 |
| **7. 用户可见交互修正** | 本机权限确认后，已经打开的外部 MCP 弹窗会原地恢复保存、探测与项目恢复操作；远程仍只读。 |
| **8. 验收** | Web 回归在 drift check pending 时打开弹窗，随后返回 `syncAllowed=true`，无需重开即可看到保存控件。 |

### 补充诊断胶囊：Thread detail 对账必须 latest-request-wins

| 栏位 | 内容 |
|------|------|
| **1. 现象** | mount 触发的 thread detail GET 与 invocation-end 触发的 GET 重叠时，较旧响应可能最后到达并把新的 `projectPath` 覆盖回旧值。 |
| **2. 证据** | 精确 HEAD `c3f0b84dc` 上，两个触发点共用 `syncThreadState()`，每个成功响应都会无条件调用 `syncThreadDetailToLocalState()`，没有 abort 或 generation 检查。 |
| **3. 根因** | 对同一权威资源的并发读取缺少请求世代；网络完成顺序被误当成数据新旧顺序。 |
| **4. 诊断策略** | 在唯一 `syncThreadState()` 入口递增 generation；只有当前最新请求允许写 store，线程切换自然使旧 generation 失效。 |
| **5. 超时策略** | 若组件级 generation 无法覆盖 thread 切换，改为带 threadId 的 token，而不是在每个触发 effect 增加独立布尔值。 |
| **6. 预警策略** | 若只保护 `setCurrentProject` 或只保护 threads 数组，另一份镜像仍会回退；必须在调用统一对账函数前整体拦截旧响应。 |
| **7. 用户可见交互修正** | invocation 结束后的最新项目绑定不会再被较早的 mount 请求回滚。 |
| **8. 验收** | Web 回归让第二次 GET 先返回新路径、第一次 GET 后返回旧路径，最终 store 与 current project 都保持新路径。 |

### 补充诊断胶囊：Skill 源根必须指向持久 workspace

| 栏位 | 内容 |
|------|------|
| **1. 现象** | Nalo 的 `anime-forge` 四个 provider 均链接到 `/Volumes/WorkSSD/clowder-ai/cat-cafe-skills/anime-forge`，runtime 却把它们报告为同名冲突，并警告立即同步会覆盖已有内容。 |
| **2. 证据** | 四个实际链接均解析到持久 workspace 的 tracked `anime-forge` 目录；`/api/drift/check` 返回四个 conflict。`resolveCatCafeSkillsSource()` 只返回当前 runtime worktree 的 `cat-cafe-skills`，没有 runtime→workspace 重定向。 |
| **3. 根因** | Skill 的 canonical source 仍绑定可丢弃 runtime checkout，而 capability 配置和既有项目链接以持久 workspace 为真相源；相同内容的不同绝对路径被 symlink 检测器正确地视为冲突。 |
| **4. 诊断策略** | 让中央 `resolveCatCafeSkillsSource()` 对当前 worktree source 复用 `redirectRuntimeProjectPath()`；开发 worktree 保持自身 source，runtime 映射到 workspace 同相对路径。 |
| **5. 超时策略** | 若中央重定向影响开发 worktree，停止在 route 层特判，给源根解析器注入 runtime/workspace 根并用纯单元测试钉住两种模式。 |
| **6. 预警策略** | 若方案改写 Nalo 链接、复制 skill 内容或让 conflict 同步继续覆盖，说明在修数据而不是修坐标系。 |
| **7. 用户可见交互修正** | Nalo 的四个合法 `anime-forge` 挂载不再显示冲突；无需备份或重新同步现有链接。 |
| **8. 验收** | 路由回归模拟 runtime 与 workspace 分离，项目链接指向 workspace；`anime-forge` 不产生 drift。实际 Nalo 只读复查四个 provider 均为 configured。 |

## Bug report 五件套

1. **报告人**：co-creator 在 cpolar 远程使用时发现 Agent 同步状态异常。
2. **复现步骤**：runtime worktree 与持久 workspace 分离；runtime capabilities 无 MCP、workspace 有核心 MCP；运行 Agent Hook 健康检查。
3. **根因分析**：Agent Hook MCP 路径遗漏持久根重定向，错误地把二进制 worktree 当作配置真相源。
4. **修复方案**：复用 `redirectRuntimeProjectPath()`；不复制配置、不放宽远程门禁、不删除 MCP。
5. **验证方式**：Red→Green 根映射测试、Agent Hook 定向测试、实际配置只读复查。
