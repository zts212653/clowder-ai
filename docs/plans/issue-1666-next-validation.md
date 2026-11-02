---
feature_ids: []
topics: [codex, proxy, windows, issue-1666, validation]
doc_kind: note
created: 2026-11-03
---

# Issue #1666：next 移植验证记录

本轮目标、调用链、环境权威、范围和回退见 [方案](issue-1666-next-proxy.md)。
本记录只证明已运行的检查；真实企业本地 provider 验收仍未完成。

## RED 与修复

在 next@917120d55 的原实现观察到三个明确失败：

1. 实际 DirectAgentCarrierSession 子进程恢复了完整环境中已删除的 ambient 键。
2. 父 HTTP_PROXY 变化，prepareCodexHostLaunch 的签名不变。
3. 同一 native session 续聊错误复用了旧代理环境的 idle host。

修复后同组通过。host 的签名、认证读取和 launch 使用同一净化快照；
exec/direct/host/tmux 透传 inheritParentEnv=false，默认部分环境调用方仍可继承。
自查还发现提前净化会删除普通 exec 显式执行 ID；新增 RED 后复用
buildChildEnv 的 bindExecutionOwner=true 解决，不允许 ambient owner 进入共享 host。

## 本地验证

| 检查 | 实际结果与边界 |
| --- | --- |
| 基线 API build | 通过，未启动 API 服务 |
| 修复后 API TypeScript 编译 | 通过；完整构建在最终 HEAD 再执行并登记 |
| 最终定向 JS 回归 | 初版 55 项：53 通过、2 Unix 专属跳过；包含新测试、host pool、认证变化 |
| 新网络/调用回归 | 显式例外、大小写、缺失/空、静态规则、PAC/WPAD、失败保留；普通与续聊、原生 capability/首次/续聊 |
| F320 / 原生账号 / Windows shim | 66 项：62 通过，4 个 pooled fixture 在 Windows 失败；产品在 Windows 禁用 Unix pooling，交 Linux CI 验证 |
| 较宽 provider 回归（初次） | 115 项：109 通过，6 失败；其中旧 null 墓碑断言已更新，其余为 Windows POSIX 路径、mock ENOENT/时间及无 Unix shell |
| pnpm lint | API 等包类型检查通过；Web 两个未改动 .cjs 文件触发 no-require-imports，不能声称全绿 |
| pnpm check | Windows 的 check-f290-product-copy.test.mjs 路径分隔符断言失败；相关脚本与 next 完全一致 |
| pnpm --filter @cat-cafe/api test:integration | 54 项：51 通过、3 失败；bootstrap、participants 及 Gemini native profile fixture；不是企业代理验收 |
| 本次文件 Biome / git diff --check | 通过 |
| public CI resolver | 三份新增 .test.js 全部入选；F320/原生 TS 另接 Build job，Windows Smoke 显式执行新增测试 |

远端 CI、独立 review 及最终 HEAD 以 PR 正文和任务 artifacts 的回读记录为准。
本地失败没有通过放宽产品认证、修改全局设置或改写不相关模块来消除。

## Windows 与原问题现场

- 本机 WinHTTP/Internet Settings 只读查询成功：静态代理开启、PAC/WPAD 关闭；
  ProxyOverride 含当前不支持模式。候选记录 windows_proxy_override_unsupported 并保留原环境。
- 无系统结果、读取失败、PAC/WPAD、不支持模式分别有自动回归；均不是“完整代理支持”。
- 静态转换只接受 IPv4 字面量与已承诺的回环条目；系统 hostname、通配符、<local>、地址段、端口等均不支持。
- 显式原生 respect_system_proxy 分支没有改写或验收，也没有关闭原生 feature。
- 原生配置的 custom provider 为 http://127.0.0.1:15721/v1；当前未监听。
  已向用户请求可用网关/已有认证来源，不在聊天或公共产物中收集密钥。
- 本轮真实模型调用 0 次；没有以 OAuth/openai 或假 Responses 成功替代真实本地 provider。
- 受控企业代理 + 真实 provider 的首次/续聊、正常 UI 检测添加与重启恢复仍未验收。
  因此原 Issue 不能判定解决，PR 保持草稿、不合并、不部署、不关闭 Issue。

## 作者自查与交付边界

环境权威仍是账号 finalizer + canonical buildChildEnv；网络模块只派生 NO_PROXY。
不新增缓存、host 状态、代理服务、自动重试或 provider 配置解析器。
新生产模块分别约 60–70 行，新增测试单文件不超过 200 行；已有大文件只做必要接线。
Windows 查询脚本内嵌于模块，避免安装产物找不到源目录脚本；只保留一个有界外部查询。
风险为行为/认证环境/内部 carrier 契约；无数据库迁移与生产动作。
作者自查不是 Approval，必须交非作者独立审查；真实验收缺口不能被代码批准抵扣。

## 实例与收尾

本轮没有启动 Web/API/Redis、安装 EXE、复制认证或创建原生模型会话。
测试经 with-test-home 隔离 HOME 和状态，Redis 使用不可连接端口 0；
direct 的 Node 子进程和只读 PowerShell 查询随测试退出；Unix 实际 host spawn 交 Linux CI。
测试临时数据按 harness 收尾，未操作用户 Redis、SQLite、原生历史或认证。
旧工位两份未提交记录保留；新工位 retained，等待 PR、独立 review 和真实验收。
回退只需 revert 本 PR；无需删配置、会话或持久化存储。

本地日志前缀：G:/AIwork/clowder-ai/artifacts/issue1666-next-。
任务台账：G:/AIwork/clowder-ai/artifacts/issue1666-next-20261103/instances.json。

## 独立审查 P2 修复

初审发现系统 hostname 从精确匹配变为 NO_PROXY 的域后缀匹配，可能额外直连子域。
新回归先 RED；修复后 hostname 系统例外整体进入 unsupported，不新增匹配管理层。
P2 修复后定向 56 项：54 通过、2 Unix 专属跳过。
原 HEAD 19adf9b1 的证据仍属历史，最终提交、CI、复审结果在 PR 和台账绑定。
