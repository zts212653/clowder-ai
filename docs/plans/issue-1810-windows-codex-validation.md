---
feature_ids: [F320]
topics: [windows, codex, verification]
doc_kind: reference
---

# Windows Codex 账户：验证方法与验收边界

本文提供可复用的复现与验收方法。结果应绑定被测源码、安装形式、操作系统、CLI 版本与权限条件；源码通过审查或合入 next，不代表所有 Windows 安装已验收。

## 隔离前提

API 测试通过 `with-test-home.mjs` 运行，隔离 HOME、USERPROFILE、Clowder 数据根及测试服务。原生共享 state/config/SQLite 也必须使用本次测试根，不能只隔离应用数据却写入日常原生历史。

策略样本仅写入测试子进程指定的临时 ProgramData/home。真实机器级配置保持只读；测试不得修改 Developer Mode、ACL、注册表或全局环境。

假 CLI 用于检查 argv、环境与状态转换，无凭据原生 probe 用本地假模型检查 capability。二者均不需要真实 login 或远端模型请求。记录脱敏状态及布尔断言，避免保存 token、完整 OAuth URL 或个人身份信息。

## 自动化检查

在 `packages/api` 执行：

```powershell
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 node --import tsx --test --test-concurrency=1 test/f320-windows-login.test.ts test/f320-windows-policy.test.ts test/f320-login-lifecycle.test.ts test/codex-native-compat.test.ts test/f320-effective-config.test.ts test/f320-account-launch.test.ts test/f320-managed-accounts.test.ts test/f320-login-uniqueness.test.ts test/codex-managed-layout-diagnostic.test.ts
```

Windows worker 检查需同时覆盖源码与编译产物；编译路径须先执行正常 API build。临时路径包含空格、中文和单引号，以验证 PowerShell 字面量及 npm shim 参数传递。

对受测 Windows CLI 显式启用无凭据 managed 检查：

```powershell
node scripts/with-test-home.mjs --env CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 --env F320_NATIVE_WINDOWS_TEST=1 node --import tsx --test test/f320-windows-managed.native.mts
```

该检查验证受测 CLI 的独立凭据、共享状态、单 writer、续接和原生 config writer 等既有合同。原生 config 写入必须验证 A/B home 内容及链接仍一致；通用文件 rename 实验不能替代 CLI writer 的行为证据。

在 `packages/web` 执行账户行与语言 DOM 回归：

```powershell
node scripts/run-with-node-env-test.mjs node node_modules/vitest/vitest.mjs run src/components/__tests__/f320-account-truth-locale.test.tsx src/components/__tests__/account-locale-contract.test.ts
```

## 断言分层

| 层级 | 主要断言 | 证据限制 |
|---|---|---|
| 配置与状态单测 | 平台/策略/CLI 错误可区分；有效 API-only、外部 endpoint/provider、坏 TOML 在登录前拒绝；重试与身份采用规则保留 | 注入 assertSupport 的 driver 用例只覆盖准入后、打开终端前的边界 |
| 原生 Windows fixture | `.CMD`/`.exe`、argv/env、私有 CODEX_HOME、source/dist worker、取消时子孙进程退出、owner 出生时间 | 隐藏 PowerShell 与假身份不证明可见终端或 OAuth 成功 |
| 无凭据真实 CLI | 同一 carrier 的 exact version/probe；managed layout、共享配置及状态合同 | 本地假模型与空凭据不证明用户实际登录或远端调用归属 |
| 真实安装包 | 用户亲自完成双身份登录、绑定、调用、重启和续接 | 需独立交互桌面、测试身份及明确授权 |

基线对照只用于区分既有失败与新回归，不能把失败组作为共享根安全或登录成功的正向证据。跳过、失败和未执行分别记录，不能用定向结果改写全量结果。

## 真实旅程验收

1. 在隔离安装与数据目录登记源码 SHA、包版本/摘要、Windows/CLI 版本、标准用户权限及链接能力。确认与日常实例、原生状态和回调环境隔离。
2. 从既有账户页添加 A，由用户在官方浏览器亲自授权。核对官方 status、账户及工作区身份、持久条目、备注与成员绑定。
3. 同入口登录不同身份 B，再逆序重登 A；检查默认账户未被替换，A/B 凭据独立，相同身份按既有复用规则处理。
4. 分别使用 A/B 各发一轮真实请求，以所选 accountRef、脱敏身份和实际 provider 结果验证归属。模型自称或 fixture 返回身份不能代替证据。
5. 覆盖取消、关闭终端、超时、API 退出与重试；只清本次拥有的进程树，其他活 owner 不被接管。重启后确认账户、备注、绑定及测试会话续接。
6. 分别验证有/无链接能力的标准用户场景，并完成 macOS 原流程回归。#1709 未解决的安装条件单独说明。

真实登录互不并发。已知存在另一真实登录时先等待其完成，再由用户重试；临时 HOME 不隔离回调端口。跨 API 进程的最终授权归属及回调问题见 [#1811](https://github.com/zts212653/clowder-ai/issues/1811)，不能据单个进程输出宣称通过。

上述真实旅程、安装包与跨平台项目完成前，[#1810](https://github.com/zts212653/clowder-ai/issues/1810) 保持相应验收项开放。合入源码与实际部署、用户验收分别记录。
