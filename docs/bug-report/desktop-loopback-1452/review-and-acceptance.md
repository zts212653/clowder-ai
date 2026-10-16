---
doc_kind: note
created: 2026-10-01
topics: [desktop, security, loopback, acceptance]
tips_exempt: Security correction to the existing desktop listener, with no separate user-invocable capability.
---

# #1452 loopback-only：实现与验收证据

范围真相源：`thread_muobvw9ekjosyqrp#0001790786232368-000584-9be83991`；operator授权锚 `thread_muoam919d5s6xe4l#0001790785661741-000557-65576650`。按 [#1459 maintainer方向](https://github.com/zts212653/clowder-ai/issues/1459#issuecomment-5658770842)独立抽取，参考 [whutzefengxie-ops 的 #1452](https://github.com/zts212653/clowder-ai/pull/1452) exact HEAD `a7558e0453070429651206ef773763cd415ad245`。外部 PR 保持 advisory_read_only；没有改其分支或自行合入。

实现 commit：`8d9307c32935ec9ee6db8245bc559f491a98e834`；基点 `fork/develop_base@33084dc889722c17de4bc852f762818e076d8242`；public main核验 `b1fe2966fa0a97d1e3cd2e174ed59fd1477b4fc4`。仅在两条 Next start 入口追加 `--hostname 127.0.0.1`，保留固定端口和既有解析/失败路径。API/Redis、未知实例归属、数据目录、动态端口、退出预算没有进入本切片。

## Quality gate

- public main 原始 service-manager.js 配同一回归测试，在本worktree `.acceptance/public-main` 运行：11 FAIL / 1 PASS；均缺少 hostname。日志 [public-main-red.txt](evidence/public-main-red.txt)。候选测试与现有 service-manager 测试：16 PASS / 0 FAIL；日志 [targeted-green.txt](evidence/targeted-green.txt)。
- 覆盖 darwin/linux/win32 的 deployed、pnpm、hoisted 入口，Windows 本地/PATH shim，以及 POSIX 缺入口的拒绝路径。VM 模拟平台并捕获真实方法参数，无运行实例或用户存储访问。
- 本worktree 自装 Next 14.2.35、React 18.3.1，构建最小 production pages fixture；由本分支真实 `_startNextJs()` 启动。HTTP 200、页面正文匹配、`lsof` 核对 PID=96609 的唯一监听 `127.0.0.1:61742`；自己的子进程已正常 SIGTERM 清理。[production-next-smoke.txt](evidence/production-next-smoke.txt)。这是生产模式监听 dogfood，不是完整已安装产品旅程。
- Worktree内安装 Biome 2.4.1 后对两个 changed JS files 运行 `biome check --diagnostic-level=error`，exit 0；`git diff --check` exit 0。既有 service-manager 的 complexity warning 仍在。无前端UI改动、无设计稿验收需求、根目录无媒体工件。
- 复跑：`node --test desktop/service-manager-loopback.test.js desktop/service-manager.test.js`。Production smoke fixture 位于本worktree `.acceptance/next-web` 和 `.acceptance/smoke-loopback.cjs`，不依赖其他worktree编译物。

五轴风险：行为=现有监听参数纠正；数据=无；安全=LAN暴露边界收紧，重点覆盖Windows fallback；契约=固定端口不变；不可逆=无。Architecture cell：现有ownership map无专门desktop listener cell；Map delta: none，沿 F113/ServiceManager 既有边界，缺cell作为review focus，不新建运行态owner。

本公共checkout保留的 inbound home-brand pre-commit hook 会错误拒绝已有 Clowder AI 文字；本切片无品牌与共享状态改动。命令范围 hooks override 提交，未改hook/runtime配置；Biome与diff检查独立完成。

## 验收边界

独立review仍待 astra，operator体验与fork soak未通过；不报告DONE。Windows参数分支的VM测试不是Windows实际安装证据。按照 astra 集成报告 commit `29eceafc1575bac579ef7758de595c1e83b2d6fd` §4/§5，真实安装产物须再保留build commit、OS/arch、Node/native ABI、安装包SHA-256及同包进程身份。此切片可独立审，不依赖整个 #1452 先合；未验证 #1519 首句模型回复/刷新恢复。
