---
feature_ids: []
topics: [windows, testing, temporary-files]
doc_kind: implementation-note
created: 2026-11-09
---

# #1912：Windows 临时目录选择与测试收尾

原始委托：`thread_owned_5e20c7ec2b594449fa5c55a1c2250d9560f82865#0001794154806703-000444-27d8d64b`。目标分支为 `next`，开发基线 `c14eed1c454244c6769306346ec1572926e17677`。

缅因猫与鲸鲸先讨论方案，再实施。Windows 原生 Node 会把 `/tmp` 解释到当前盘根；模板预加载器为每个测试进程复制配置，子进程遭终止时无法依赖自己的 exit hook 清理。旧 Bash 包装器的 `trap EXIT` 又被末尾 `exec` 绕过。

采用内置 `os.tmpdir()`，移除真实文件系统入口的 POSIX 默认值。测试入口拒绝没有盘符或 UNC 前缀的 Windows 临时根，避免错误的 `TEMP/TMP` 再次写到盘根；不猜测其他目录。协议样例、纯断言和 macOS 短 Unix socket 路径保留。

模板 helper 的内部调用变为 `createIsolatedTemplateRoot(templateSrc, optionalBase)`。直接导入使用系统临时根；经过测试包装器时使用本次 HOME 下惰性创建的 `templates`。包装器每次覆盖内部环境变量 `CAT_CAFE_TEST_TEMPLATE_ROOT`，嵌套运行各自独立；父进程在子进程终止后收尾，仍有后代存活时沿用 HOME 的保留语义。

Bash 包装器保留调用者 cwd 和子命令退出码，转发信号并等待子命令退出后运行 EXIT 清理。Redis fixture 保持证据归档语义，仅修改目录选择。AGY 的 `TMPDIR` 使用原生系统临时根；shared shell 保留 `TEMP/TMP`，这一环境传递问题单独验证。

## 验证入口

- `node --test packages/api/test/windows-temp-lifecycle.test.mjs packages/api/test/isolated-template-root.test.js`
- `node --test packages/api/test/with-test-home.test.js packages/api/test/with-test-home-account-roots.test.js`
- `node --test packages/api/test/agy-native-launch-env.test.js`
- `node --test packages/mcp-server/test/shared-shell-temp.test.js`

首批行为回归在未修改的基线上 5 项全部失败：Redis 根目录、父进程正常/强制退出后的模板收尾、Bash 成功/非零命令后的 HOME 收尾。修复后同 5 项通过，并追加盘符校验、两个工作目录下直接导入、嵌套隔离和 TERM 转发回归。Windows smoke CI 纳入临时目录回归。

本机 Windows 验证：API 及依赖构建通过；目录生命周期与模板隔离 13 项通过；现有 Node HOME 包装器与 shared-shell 临时环境共 21 项通过、3 项按既有 Windows 条件跳过；AGY 原生临时目录用例通过；修改的 46 个 JavaScript 文件通过语法检查，Biome 错误级检查通过。

扩展路由检查共 238 项，228 项通过、9 项失败、1 项要求预制 Chrome 包而跳过。相同 `c14eed1c4` 基线对照在对应 159 项中复现了全部 9 个失败，另有一个基线失败在补丁中未再出现；没有新增失败。路径迁移暴露的另一处测试软链接目标仍为 `/tmp`，已一并改为 `tmpdir()`，其回归通过。

其他基线限制单独记录：三个模板 helper 调用方共 7 项中 6 项通过，1 项 Host movement 策略断言在原基线同样失败；旧账户根测试通过 PATH 解析到本机损坏的 WSL Bash，4 项在原基线同样无法启动；旧 AGY 代理测试同时给大小写同名环境变量设置不同值，在 Windows 上发生覆盖，原基线同样失败。未为这些独立行为改动生产权限或账户策略；本次不宣称全仓测试通过。

本次不扫描或删除历史目录，不给用户数据、Redis 证据增加 TTL，不删除共享临时基目录。存量目录的归属与可删除性需独立核验；根目录 `temp` 的历史创建者仍未证实。

## 非作者复审补充

鲸鲸对首轮 HEAD `4830efd2f` 的复审指出 f296 状态文件及浏览器证据路径遗漏，已按同一根因补齐：截图、geometry 与 receipt 的默认目录和读写双方同步迁移，F309 所有截图共用既有 evidence 配置。另迁移真实写入的 transcript fixture、podcast 元数据、mutation 日志和 hold-ball CAS 数据根；依赖临时目录存在的 projectPath 测试使用系统目录，纯 mock 路径保留。

F236 是文件协议，MCP mode writer、独立 hook、API eval 桥在同一提交内同步：Windows 使用 `tmpdir()`，POSIX 保留 `/tmp`。新增真实 mode 写入→hook 读取→eval/state 桥读取→full 删除检查，并纳入构建后的 Windows smoke；测试专用身份与本机会话凭据隔离。

最终 API 及依赖重新构建通过。F236 真实文件协议、mode 生命周期、eval bridge 与 MCP credential-file 检查合计 55 项通过；最初提交的 Windows Smoke CI 也已通过，包含新增的 13 项目录生命周期检查。

f296 从 C: cwd、`C:\tmp` 不存在的状态实测 RED（writeFile ENOENT）后 GREEN。新增 F236 协议检查在生产路径修改前因目录仍为 `/tmp` 而 RED。复审增量的 48 个 JS/MJS 文件通过语法检查，Biome 错误级检查通过。现有 hook、transcript、podcast、projectPath 与 hold-ball 组合 184 项中 182 项通过；两个 durable-worker 检查在原基线源文件同样失败，未修改它们的生命周期逻辑。旧 f333 两项安装集成测试依赖 `/bin/bash`，本机未提供该绝对路径；同文件两项环境保留检查通过。未执行整套浏览器 journey，截图路径的迁移完成语法及消费者核对，不声称已完成所有浏览器场景验收。

首轮 CI 的 lint 失败源于修改 MCP 实现后摘要需要重生成；已通过官方生成器校验并同步摘要，212 个工具无增删、schema/描述/profile 等契约无变化。公开测试分片另有两个 knowledge-discovery deadline 超时，本机对应两项复测通过。最终 CI 以 PR 当前 HEAD 的检查为准。
