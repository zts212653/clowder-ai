---
feature_ids: [F171, F155, F322]
topics: [onboarding, shell, hydration, performance]
doc_kind: bug-report
created: 2026-10-14
tips_exempt: Repairs the existing first-use journey and adds local diagnostic logs; no new user capability.
---

# #1466 首屏切换与引导跳转性能

用户反馈：空白实例先显示经典欢迎页，再换新版首页；完整引导跳转卡顿。附件三份均为静态 PNG，用户授权自行录制/使用日志分析。本记录区分实际取证与尚未验证的部分。

## 根因与归属

1. `useShellPresentation` 的服务端快照默认 classic，AppShell 在 passive effect 才将 URL 的 v2 写入浏览器偏好。页面与轨道各自读取旧值，形成经典 → 新版切换。修改前这两个文件与同步的 main 相同。已用首次 layout effect 观察到 classic 的失败测试，修复为当前导航意图在首次 render 生效，并将同一个结果提供给轨道与页面；用户在同一 URL 上主动修改偏好仍生效。
   独立复核另发现浏览器拒绝 localStorage 写入时会再次退回 classic。真实 AppShell 反例已 RED → GREEN：无法持久化时由现有偏好模块保留当前 tab 的选择，恢复存储或接收跨 tab 变化时释放临时值；继续允许同 URL 手动切换。
2. 新的 v2 首屏渲染暴露了身份缓存的 hydration 问题：另一个边界在头像水合前完成配置读取，客户端首字从服务端 M 变为首，触发 React 放弃该边界并重新绘制。`useCoCreatorConfig` 改用固定服务端快照和订阅缓存，补充真实 hydrateRoot 回归；不使用 suppressHydrationWarning 隐藏错误。
3. 本 PR 的演示/首页创建入口使用普通 a，会整页重载并重建客户端。改为 Next Link 的站内导航，保持文档和会话初始化连续。
4. 验收实例是 Next dev。日志记录首页首次编译 24.7 秒，设置页首次编译 8.7 秒；已热页面返回 55–123 毫秒。实际开发版诊断读取脚本解码体积 91,777,129 字节，TTFB 468ms、客户端初始化观察点 1795ms。不能把这些开发态耗时包装成发布版性能，也不能以预热一次声称首次访问已修好。

## 分段取证

- 会话 API 首次 3ms；模板 API 17ms 中位数 / 26ms 最大值。
- 原生工具认证发现 10 次记录：中位数 2303ms / 最大 3354ms。这里是真实 CLI 检查，不属于演示模型等待，也不能改成读取文件后就宣称可用。
- 演示打开至挂载 33ms；九个预置阶段停留 2.6–5.5 秒，实际计时偏差 0–15ms。停留用于阅读与协作节奏，不计为路由卡顿。
- 新增 `[onboarding-performance]`：入口到挂载/检测完成、文档 time origin、各演示阶段 planned/elapsed/late。`?diagnostics=onboarding` 额外记录首次页面资源与初始化观察点。均为本地日志，不记录角色身份、提示词、认证或远端遥测。

## 验证与部署边界

- 经典与新版偏好、导航、保留未发送草稿、文档语言、浮动窗口回归已通过；首屏首次绘制与身份 hydrateRoot 均观察 RED → GREEN。
- 最终相关首启/shell/设置/身份回归 38 文件 156 项通过；正式 Next build（含类型检查）成功。独立复核通过源码 `0e8d3f247cf8262817651656e7befc6a3af3fafb`，原 storage P2 已闭环。
- 继续同一 feature worktree / PR #1519；现有生产、5150 与用户 5152 数据保留。正式性能复验使用独立构建目录；API/Web 的 revision stamps 应对应真实构建，禁止绕过部署一致性保护。

## 正式构建实页结果

5152 Web / 3152 API 已切换到独立部署副本，版本为 `0e8d3f247cf8262817651656e7befc6a3af3fafb`；6366 Redis 保持原进程，API health revision 和 ready 均通过。重启前后 2 个角色、1 个会话的标识一致，cat-template 配置摘要一致。生产 3003/3004/6399 的监听进程未改变。

| 观察点 | 正式版实测 |
| --- | --- |
| 首次浏览器文档 TTFB / HTML 返回 | 385ms / 396ms |
| AppShell 客户端初始化观察点 | 743ms |
| 已加载脚本解码体积 | 5,916,564 字节；开发版为 91,777,129 字节 |
| 点击首页演示 → 演示挂载并自动开始 | 5ms |
| 9 个演示阶段计划计时的实际偏差 | 1–15ms |
| 演示成果 → 创建页挂载 | 70ms |
| 同一次点击 → 推荐结果就绪 | 2458ms，包含 CLI 登录检测 |

这些是本机各一次真实路径观察，不是跨机器基准；脚本数字是解码体积，不是传输量。`hydratedMs` 表示 AppShell effect 的初始化观察点，不能当作所有 React 边界水合完成。

实页从首屏即为新版首页；正式版复测未捕获 hydration 或其他浏览器 error。演示实际自动完成设计 → 开发 → 审查 → 返工 → 复核，并在同一个右侧成果中成功添加任务。创建 Link 的 documentTimeOrigin 与首页相同，dialog 和 iframe 均清理为 0，推荐结果识别原已添加的 Codex / Claude，未重复创建角色。CLI 检测仍需约 2.4 秒，页面先显示明确的检测进度，未通过省略认证检查伪装成秒开。

取证位置（本机独立实例，未发布认证或用户内容）：`artifacts/issue1466-zero-start-20261013/production-browser-timings.json`、`before-production-switch.json`、`after-production-switch.json`、`final-perf-regression.log`、`production-build.log`、`production-homepage.jpg`、`production-demo-complete.jpg`、`production-team-setup.jpg`。

截至本轮核对，远端 main 又前进至 `449134fed`，只读 merge-tree 发现新的配置/布局等合流冲突。本次首屏修复与已部署验收不等于整条 PR 可以合入，最新 main 合流和全量 CI 仍需另行验证。

顺带定位旧 HEAD 的 public test 红灯：`native-runtime-routes.test.js` 探测 GET 没有带测试用户身份，真实返回 401；补身份后又复现旧 `not_checked` 断言，当前接口已进行本地登录检查并返回 `local_checked`。修正该测试前提，增加匿名 GET 仍应 401 的断言；真实 RED → GREEN。未修改接口、降低鉴权或伪造可用性。远端新提交的 CI 结果仍需等待，不能用这项定向通过声称全量绿灯。

本轮 fallback 机械扫描以原 HEAD `8838bc10a` 为比较基准：诊断 helper 的 6 处命中包含条件校验 `||`、JSON 空值与两个浏览器存储 try/catch，不是 6 层执行降级；不能移除，否则拒绝存储会干扰核心导航。Shell 使用现有 owner 的一个临时偏好，SSR 身份使用固定快照，未新增第二套角色/认证配置 owner。既有 AppShell/身份文件累计阈值由原有分支贡献，不新增兜底链。
