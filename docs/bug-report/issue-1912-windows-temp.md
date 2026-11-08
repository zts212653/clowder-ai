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
