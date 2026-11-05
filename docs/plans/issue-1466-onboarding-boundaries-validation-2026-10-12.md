---
feature_ids: [F171, F155]
topics: [issue-1466, onboarding, native-runtime, verification]
doc_kind: validation-report
created: 2026-10-12
---

# #1466：引导边界与真实多伙伴协作验证

## 本轮问题与实现

用户验收发现：初版虽然创建三位伙伴，但第一条任务只召唤首位；此前也缺少无工具等边界的真实页面证据。

现在多伙伴小目标在确认前展示顺序和职责，发送草稿明确召唤所有已选伙伴，使用已有 `#execute` 串行 worklist。第一位提方案，中间伙伴检查补充，最后一位检查并汇总；两位时第二位兼任检查和汇总。单伙伴保持简单消息。用户仍需点击聊天发送按钮才开始调用。

检测失败与未安装分别展示；无工具提供官方安装文档、重新检测和稍后配置，不允许继续创建。DSH 程序已发现但 ACP profile 缺失时提示待配置 ACP。已有或新建伙伴取消选择后，重新检测保留用户选择；新发现工具才自动推荐。部分保存失败保留成功记录，重试沿用幂等身份。

## 隔离验证与截图

代码在 `worktrees/feat-onboarding-first-run`。新增验证实例 Web `5140`、API `3140`、独立 Redis `6372`，独立 HOME、配置副本、应用数据与 cookie。通过独立 PATH/HOME/缓存构造无工具和单工具场景；未卸载本机程序、修改全局认证、清理数据或操作生产 `3003/3004/6399`。

| 场景 | 实际操作与结果 | 截图 |
|---|---|---|
| 无工具 | 空独立 HOME/PATH，真实发现 API 返回均未安装；继续按钮禁用 | [界面](../design/assets/issue1466-native-onboarding/no-client-desktop.jpg) |
| 安装帮助 | 展开 Codex 帮助，官方文档与重试可达 | [界面](../design/assets/issue1466-native-onboarding/no-client-install-help.jpg) |
| 检测失败 | 停止本次自建 API，再点击检测；失败不伪装为无工具，禁用继续。随后恢复 API | [界面](../design/assets/issue1466-native-onboarding/detection-unavailable.jpg) |
| 仅有 Codex | 独立 PATH 加入已安装 Codex，重试后仅此项可选 | [界面](../design/assets/issue1466-native-onboarding/one-client.jpg) |
| 单伙伴目标 | 没有多余的主执行人选择 | [界面](../design/assets/issue1466-native-onboarding/one-partner-goal.jpg) |
| 三伙伴目标 | 恢复三个本机工具，选择与目标保留，显示分工 | [桌面](../design/assets/issue1466-native-onboarding/team-goal-desktop.jpg) / [390px](../design/assets/issue1466-native-onboarding/team-goal-mobile.jpg) |
| 实际执行 | Codex → Claude → DSH，三次真实调用及独立回复 | [结果](../design/assets/issue1466-native-onboarding/team-real-result.jpg) |

上述均为项目运行页面，不是独立原型或注入的演示消息。小屏正文滚动，底部动作保持可达。DSH 缺失 profile、部分保存失败有自动化覆盖，但本轮没有其真实页面截图；不能把这些情况算作人工视觉验收。

## 真实协作证据

2026-10-12 14:26–14:31（上海时间），在隔离实例发送“个人待办清单最小可用版本和三个步骤，先不改文件”的小目标：

| 顺序 | 真实 invocation | 可核对的行为 |
|---|---|---|
| Codex | `7b05ceb8-fb79-47a3-aeda-7b55324789bb` | 第一棒提出单人单清单网页方案 |
| Claude | `fe25d147-ba59-48ca-83b5-d8077ac7c607` | 输入上下文包含第一位已持久化回复；输出明确阅读该方案，再补输入校验、持久化失败等边界 |
| DSH | `9cf42390-ebe2-4899-a2a9-2d8dac839ff0` | 逐项列出前两位建议的采纳/修正表，补充文本安全渲染，汇总最终范围和步骤 |

三位分别产生持久化消息，未以一只猫模拟其他身份。执行与顺序由现有路由保障；回答是否提出有价值的改进仍是模型输出质量，需要持续评估，不能保证所有目标都有同样结果。

## 运行时 P1 与 CI 修复

- 旧 synthetic native Codex 绑定沿用 `auto` 认证选择，持久 OAuth 绑定仍明确 OAuth，修复误把旧原生配置强制为 OAuth 的兼容问题。
- POSIX 模型目录探测使用独立进程组和唯一 owner token；关闭、超时、错误、非法 JSON、输出上限、父进程退出时按进程身份清理所属 worker，包含 TERM 不退出及脱离父进程的后代；不杀无关进程。Windows 保留已有树清理路径。
- CI 修复覆盖 env registry、旧 ACP 模型解析、旧账号展示、Codex carrier source guard、跨平台退出 fixture、Web 成员删除行为测试及格式规则。旧引导组件 import/格式整改不改变产品路径；输入焦点改为 ref + effect，并补行为测试。
- 新增 POSIX fixture 在首次 Linux CI 暴露“先开始读 stdin，后注册监听”的握手竞态。相同 fixture 本机对照：原先 ready 请求超时，修复后 124ms 返回真实父/worker PID；不放宽回收断言和 deadline。

本机证据：Web 扩展回归 **29 文件 / 103 测试通过**；Web 源码类型检查通过；后端兼容相关 **93 测试通过**，另 native ACP **14 通过**，运行时回归在 Windows **10 通过、6 个 POSIX 专用用例跳过**。独立 reviewer 已复核运行时提交 `313de1acd`，未发现新 P1/P2；这不替代新提交的 Linux CI 与正式 PR review。

Linux 专属进程回收及最终 CI 结论以 PR #1519 最新提交的 Actions 和 review 评论为准；本文不将 Windows 跳过或仍运行的 CI 计为通过。

## 尚未完成的 issue 范围

一键安装、登录/授权向导、完整训练营进阶内容仍未交付；当前提供官方安装入口，沿用工具已有认证。旧生产实例未更新，既有用户隔离实例 `5138 / 3138 / 6374` 数据继续保留。此次交付不自动关闭整个 #1466，也不代表已批准合并。
