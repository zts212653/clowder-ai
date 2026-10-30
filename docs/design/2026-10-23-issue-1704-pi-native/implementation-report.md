---
feature_ids: []
related_features: [F241, F289]
topics: [pi, acp, sessions, recovery, diagnostics, issue-1704]
doc_kind: verification
created: 2026-10-23
status: implementation_verified_peer_reviewed
tips_exempt: 既有 Pi 连续性与错误处理修复，没有新增入口或独立使用步骤。
---

# 实施与验证报告

用户已批准按推荐路线在原方案工位实施，并要求 W0、冷恢复、首轮空响应、验证及 PR 一并完成。基线 public main `c7be47576cada416721ff93230d205417f6c0895`，已接受的方案提交 `cec3708a8a2ab539ebd8f2e427135054ae37a9d2`。

## W0 已验证的决定

- Pi 1.3.0 + Node 24.16.0 支持本方案版本化 native ID、显式目录和精确文件 load。无 prompt 时原生文件惰性落盘；缺失 `--session-id` 会新建，故 load 绝不用该路径。
- 精确文件恢复后，真实 provider messages 保留前轮测试词；不靠替换 ID/重放摘要恢复。
- Pi 载入文件时可能迁移并写回，因此写者锁在导入 CLI 之前取得；实际 Pi 进程以 Node 内置 SQLite 持有排他事务，强引用保留至退出。不引入 native addon ABI 依赖，也不依赖父 PID/超时。
- Windows SQLite 原始长路径超过 260 字符出现 `unable to open database file`；命名空间路径通过，正式 runner 已采用。
- Host 把普通 load 错误视为可新建，故增加内置 Pi 专属错误码及绑定错误映射；全局回退规则不放宽。
- Host 重启会为 MCP 刷新文件生成新 nonce 路径。冷恢复仅对已知回调服务器归一化该暂态路径；活跃进程仍严格比较原运行绑定。
- Host 的 sessionId 存储/恢复接口消费不透明字符串；新增 ID 长度约 50 字符。真实 Client/Service/池和原生回读已通过，不只依赖静态接口判断。

## 实现范围与来源复用

内置桥 1.1.0 新增原生持久化与精确 load、同桥并发合并、跨进程单写者、每轮原生身份核验、MCP 稳定命名与当次凭据，以及有界脱敏 RPC/stderr 诊断。正常空完成保留 Host `empty_response`，有效工具完成不误报空响应。

复用 [fork #14](https://github.com/whutzefengxie-ops/clowder-ai/pull/14) @ `ecafa76d9af0f9438c179a652e27e51229e5b462` 的空 delta 防护和空内容夹具意图；扩展 final 文本对账及 Host 分类，没有整包引入 DSH/账户改动。参考 [插件仓 #104](https://github.com/zts212653/clowder-ai-plugins/pull/104) @ `a2d6b65fde77baee98175dbeb03c656926e889a9` 的原生恢复/MCP 对照，未复制其适配器源码或引入安装依赖。[#1596](https://github.com/zts212653/clowder-ai/pull/1596) 的恢复回退风险由保留精确绑定失败处理规避。

新增状态 owner/path/lifecycle/兼容/回退及根迁移消费方见 [资产 census](../../census/issue-1704-pi-native-state.md)。Architecture cell：`identity-session`；Map delta：Pi 原生历史与写者边界；Why：Pi 拥有模型上下文，Host 拥有应用消息和调用权限，桥不新增第二套历史权威。

## RED → GREEN 与命令

原基线观察到 6 项新回归 RED：无 load、MCP/写者/历史保护缺口、空 delta 阻断 final、部分流丢失 final 后缀。随后单独观察到 Host 重启更换 credential-file 和原生 ID 意外变化的 RED；修复后同一组检查通过。

独立审阅 `6e1623c3` 后又复现两项 P2：合法 header 后的损坏 JSONL 会被 Pi 1.3 静默跳过；逐行脱敏会漏掉跨行 PEM 正文。两项新增用例均先观察到 RED。现由实际 writer 持锁后逐行校验 JSON 语法、记录基本形状和原生 header，再导入 Pi；坏文件不改写、不替换，验证失败释放锁。诊断先识别完整 PEM 块，覆盖跨 chunk、超长行和缺失 END，正文不进入可见截尾。

复审 `386b6927` 发现预检 `readline` 与 Pi 的分行语义不同：裸 CR 会被前者分行，后者只认 LF。该反例先 RED，随后改为严格 LF 增量扫描，保留合法 CRLF 支持；损坏文件不改写、原生 loader 不启动。对本次 Pi 目录的 header、RPC、ACP 和诊断分帧位置同步扫描，其他位置均按 LF，未遗留同类 `readline` 解析。

| 验证 | 当前结果 |
| --- | --- |
| `pnpm --filter @cat-cafe/api build` | 通过，当前源码重新编译，F299 census 检查通过 |
| `pnpm --filter @cat-cafe/api lint` | 通过 |
| Pi bridge/RPC/empty/native recovery/Host/storage boundaries + ACP cache/resume/discovery/pool/signature/registry/bootstrap + 原生路由/错误持久化 | 105 项：104 通过、0 失败、1 跳过；跳过为需要额外 DSH 审计安装路径的用例，与 Pi 无关 |
| 真实 Pi + 受控 OpenAI-compatible 接口 | 新建、热续聊、重建桥后同 ID 冷恢复及 provider 原历史通过；真实 Host 空完成/失败 load 分类通过 |
| 真实 MCP + 受控 provider | 新会话及冷恢复后工具真实执行并落 receipt；冷恢复使用新的 credential-file 和 invocation，原 ID 保持 |
| 真实自定义 LLM | `6e1623c3` 三次真实调用：首轮、热续聊、重建桥后的冷恢复均记住 `CEDAR1704`；审查修复未重复付费调用，新增前置校验已用真实 Pi + 受控接口重跑冷恢复/MCP |
| `pnpm check` | 未全绿：停在未修改的 F290 Windows 路径分隔符断言；没有将其标为通过 |
| 公开测试发现与能力提示 | 四个新增 `.test.js` 均进入实际 public test selection；`pnpm check:capability-tips` 通过，保留既有 10 条提示警告 |

定向测试在 `packages/api` 使用现有 `scripts/with-test-home.mjs` 和 `--import ./test/helpers/setup-cat-registry.js`；Windows 将 TMPDIR/TEMP/TMP 指向本工位 `.cat-cafe/issue1704/test-tmp`。入口为 `test/pi-*.test.js` 五组加既有 native ACP 与 `test/acp/acp-{process-pool,pool-signature,pool-registry,bootstrap-startup-policy}.test.js`。新增用例使用公开 `.test.js` 发现路径，未另造私有测试入口。

W0、原生 fixture、真实 LLM 账本和编译模块 SHA-256 保留在本工位 `.cat-cafe/issue1704/`；所有真实调用均使用独立原生目录。私有模型配置、native JSONL 和原始日志不提交 Git。原 Pi models/auth/settings 哈希未变；各实验桥进程退出、临时回环接口关闭，持久数据保留。

F290 失败已从 `upstream/main` 原样提取两份检查脚本再次复现，准确差异为 `packages\\collective-client\\src\\ProductShell.tsx` 与斜杠路径；检测脚本未改。ownership README 使用原生成器在 LF 规范化的临时镜像生成，避开 Windows checkout 的 CRLF 解析限制，没有改生成器源码。

fallback 检测对新模块的 `||` 输入校验与 `try/catch` 触发警告。已检查这些位置：恢复权威收敛为原生文件，未增加 transcript 镜像或替代会话路径；身份、cwd、MCP、格式、文件类型与活跃写者保护均需保留；catch 仅向外传递脱敏失败，不吞错后切换历史。此次增加的是边界拒绝，不是多级恢复猜测。

补充边界：Windows 实测桥被强制结束后其测试子进程也退出，因此“无桥状态但写者存活”用独立的生产 runner 持锁验证，不把它写成现场实测遗孤进程。该用例确证没有 Bridge Map 也不能抢占存活的真实写者。

## 本次声明的限度

2026-10-23 本地独立复审回执：`Review-Subject-Ref=issue1704/native-pi-recovery`，`localReviewVerdict=approved`，`reviewedHeadSha=9237455728a51da8bbe60f52e67462cebcdf52c5`，accepted source 为 `cec3708a8a2ab539ebd8f2e427135054ae37a9d2` 的 `recommended-design.md`。审阅者独立重跑四组 18 项全过，未确认剩余 P1/P2；本回执与索引状态是后续仅文档提交，不改变已审源码。此结论不代替维护者合入决定或企业现场验收。

冷恢复和首轮事件转换/错误传递已在上述层级验证。企业机那次首轮空响应究竟由网关、模型、启动 shim 还是其他因素触发，仍没有同版本完整事件链；本 PR 不宣称该现场诱因已被确定，不自动关闭 #1704。

没有部署企业机、重启用户 runtime、修改 UI 或生成/安装新 EXE。企业最终安装路径、完整 GUI 旅程和现场首次空响应仍按 W5 复验；源码集成、真实 Pi/LLM/MCP 证据不冒充安装包和企业验收。
