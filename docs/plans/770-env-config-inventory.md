---
topics: [env-registry, system-settings, config-projection, module-sections]
created: 2026-08-12
---

# #770 Env Registry Remediation Inventory

> Baseline: `packages/api/src/config/env-registry.ts` @ `00af81c32c9bda328cef8551de5c846a25760550` (main at PR-A branch-off).
> Overlay A: PR-A `fix/770-section-projection` @ `ff67390aa3c49f6e9514e18050f7dcb7d7f7eaaa` (section projection + control metadata).
> Overlay B: PR #1340 `fix/770-registry-metadata` @ `f652dd3ba` (deprecated markers + `DEFAULT_OWNER_USER_ID` projection).
> Classification: 保留 System / 清出 System / 投影到模块 / 不进 UI / 组件补齐 / 产品待决策.
>
> **PR-A retraction notice (HEAD `f790c4ed2`)**: the original 42-var “投影到模块”
> allowlist has been revoked after a source audit. `env-sections.ts` now ships with
> empty module projections; the section/filter/write-policy infrastructure stays in
> place. Per-module projected sets will be re-added in PR-C only after each module
> UI owner confirms a real missing surface. See the Summary and PR-C sections below.

## Legend

- **category**: registry category as defined in `env-registry.ts`
- **var name**: env var name
- **section target**: owning module (`system / im / voice / notify / mcp / plugins / ops / accounts / members / rules / concierge / frontend / none`)
- **registry summary eligible?**: whether the var is eligible for the canonical env summary (`hubVisible !== false`); this is **not** a guarantee that the var is surfaced in a Hub editor today
- **current editable**: current overlay value (`runtimeEditable === true`)
- **target write policy**: intended final write semantics (`editable` / `read-only` / `read-only, opt-in editable` / `module-managed` / `no UI write`)
- **control type**: inferred `text / toggle / dropdown / dirpicker`
- **dead config?**: `yes` if the description marks it deprecated
- **覆盖类型**: `exact` (component directly consumes this env var) / `equivalent` (component uses an alternative store such as ConfigStore/themeStore; env is only bootstrap/fallback) / `none` (no UI coverage) / `N/A` (保留 System)
- **现有 UI 覆盖**: component path if an existing module UI already covers this domain
- **disposition**: `保留 System` / `清出 System` / `投影到模块` / `不进 UI` / `组件补齐` / `产品待决策`

## 服务器 (58)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| server | API_SERVER_PORT | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | PREVIEW_GATEWAY_PORT | system | yes | yes | editable | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | API_SERVER_HOST | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | CORS_ALLOW_PRIVATE_NETWORK | system | yes | no | read-only | toggle | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | PROJECT_ALLOWED_ROOTS | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | PROJECT_ALLOWED_ROOTS_APPEND | system | yes | no | read-only | toggle | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | PROJECT_DENIED_ROOTS | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | FRONTEND_URL | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | FRONTEND_PORT | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | DEFAULT_OWNER_USER_ID | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | owner/trust-anchor，security group，只读，restartRequired；未设置 ⇒ 单用户本地模式（#1340 投影结论） |
| server | CAT_CAFE_USER_ID | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_F255_AWAKENED_LEASE_MS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_HOME | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_INVOCATION_REGISTRY | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入 |
| server | F233_BALL_CUSTODY_PROBE_INTERVAL_MS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_REPO_FULL_NAME | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_AGENT_KEY_SECRET | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_AGENT_KEY_FILE | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_AGENT_KEY_FILES | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_REMOTE_PORT | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_GPT_PRO_AGENT_KEY_FILE | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_ENABLE_LEGACY_PINCHTAB_BRIDGE | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_REMOTE_TOKEN | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_DESKTOP_MODE | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_PROVISION_GLOBAL_SIDECAR | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_AGENT_KEY_ALLOW_MEMORY_SIDECAR | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_AGENT_KEY_SIDECAR_DISABLED | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_TEST_SANDBOX | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 测试/调试专用 |
| server | CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 测试/调试专用 |
| server | CAT_CAFE_TEST_REAL_HOME | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 测试/调试专用 |
| server | CAT_CAFE_REDIS_TEST_ISOLATED | none | no | no | no UI write | dropdown | no | none | 无 | 不进 UI | 测试/调试专用 |
| server | CAT_CAFE_SERVICES_CONFIG | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | RUNTIME_REPO_PATH | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | WORKSPACE_LINKED_ROOTS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | ANTHROPIC_API_KEY | accounts | no | no | module-managed | text | no | equivalent | HubAccountsTab.tsx → `/api/accounts` → accounts/credentials store → account resolver/resolveEnvMap → provider env injection | 清出 System | 由统一账户/凭证系统管理；env 仅作 bootstrap/fallback |
| server | LOG_LEVEL | system | yes | no | read-only | dropdown | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | LOG_DIR | ops | yes | no | read-only | dirpicker | no | none | 无 | 不进 UI | 日志目录；不进通用 projection |
| server | DEBUG | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 测试/调试专用 |
| server | PREVIEW_GATEWAY_ENABLED | system | yes | no | read-only | toggle | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS / System Settings 中 |
| server | CHROME_EXECUTABLE_PATH | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | GAME_NARRATOR_ENABLED | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 测试/调试专用 |
| server | COMMUNITY_PUBLISH_DEFAULT_REPO | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | COMMUNITY_PUBLISH_REPO_ALLOWLIST | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | COMMUNITY_NARRATOR_THREAD_ID | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | WEB_PUBLIC_DIR | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_CONFIG_ROOT | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_GLOBAL_CONFIG_ROOT | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_SKIP_HOMEDIR_MIGRATION | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 测试/调试专用 |
| server | ALLOWED_WORKSPACE_DIRS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_RUNTIME_ROOT | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_WORKSPACE_ROOT | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_MCP_CREDS_DIR | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| server | CAT_CAFE_AUTH_TOMBSTONE_GC_TTL_MS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用（auth tombstone GC TTL） |
| server | CAT_CAFE_VERDICT_REPO_FULL_NAME | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用（verdict repo 绑定） |
| server | CAT_CAFE_AGENT_KEY_BOUND_CAT_ID | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入（agent-key 绑定身份） |
| server | CAT_CAFE_PERSONAL_CHROME_SOCKET | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用（personal chrome socket） |
| server | CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用（personal chrome 配对密钥） |
| server | CAT_CAFE_PERSONAL_CHROME_WEB_STORE_URL | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用（personal chrome web store） |

## 存储 (15)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| storage | REDIS_URL | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| storage | REDIS_KEY_PREFIX | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| storage | REDIS_DATA_DIR | none | no | no | no UI write | text | no | none | 无 | 不进 UI | Redis 数据目录，由 shell 启动脚本在 API 前设置；DATA_DIR 设置后覆盖 |
| storage | REDIS_BACKUP_DIR | none | no | no | no UI write | text | no | none | 无 | 不进 UI | Redis 备份目录，由 shell 启动脚本在 API 前设置；DATA_DIR 设置后覆盖 |
| storage | MEMORY_STORE | system | yes | no | read-only | toggle | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| storage | MESSAGE_TTL_SECONDS | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| storage | THREAD_TTL_SECONDS | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| storage | TASK_TTL_SECONDS | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| storage | SUMMARY_TTL_SECONDS | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| storage | BACKLOG_TTL_SECONDS | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| storage | DRAFT_TTL_SECONDS | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| storage | DATA_DIR | system | yes | no | read-only | dirpicker | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | issue #671 持久数据根目录 |
| storage | CACHE_DIR | system | yes | no | read-only | dirpicker | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | issue #671 可重建缓存根目录 |
| storage | ANNOTATION_DATA_DIR | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 系统级存储路径，保留在 System view |
| storage | DOCS_ROOT | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 系统级文档根目录，保留在 System view |
| storage | VISIBILITY_CURSOR_V2 | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级 activation gate |

## 猫猫预算 (2)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| budget | MAX_A2A_DEPTH | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | A2A 预算阈值，保留在 System view |
| budget | WEB_PUSH_TIMEOUT_MS | notify | yes | no | read-only | text | no | none | 无 | 不进 UI | Web Push 超时；不进通用 projection |

## CLI (36)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cli | CLI_TIMEOUT_MS | system | yes | no | read-only | text | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| cli | CAT_CAFE_SUPERVISOR_PARENT_PID | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入 |
| cli | CAT_CAFE_SUPERVISOR_POLL_MS | none | no | no | no UI write | text | no | none | 无 | 不进 UI | CLI 内部/调试/路径配置 |
| cli | CAT_CAFE_SUPERVISOR_KILL_GRACE_MS | none | no | no | no UI write | text | no | none | 无 | 不进 UI | CLI 内部/调试/路径配置 |
| cli | CAT_TEMPLATE_PATH | members | yes | no | read-only | text | no | none | 无 | 不进 UI | 成员/模板默认值；不进通用 projection |
| cli | DEFAULT_CAT_ID | members | yes | no | module-managed | text | no | equivalent | DefaultCatSelector → PUT `/api/config/default-cat` → `persistDefaultCatToEnv` + `setRuntimeDefaultCatId` → `getDefaultCatId` / cat loader → env fallback | 清出 System | 默认猫选择，已有 DefaultCatSelector UI 覆盖；env 仅作 bootstrap/fallback |
| cli | CAT_CAFE_MCP_SERVER_PATH | mcp | yes | no | no UI write | text | no | none | 无 | 不进 UI | MCP 路径/凭证目录，内部运行时配置 |
| cli | AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS | ops | yes | no | read-only | text | no | none | 无 | 组件补齐 | 审计日志隐私开关；需专用组件 UI，不进通用 projection |
| cli | CAT_BRANCH_ROLLBACK_RETRY_DELAYS_MS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | CLI 内部/调试/路径配置 |
| cli | MODE_SWITCH_REQUIRES_APPROVAL | none | yes | no | no UI write | text | yes | none | 无 | 不进 UI | [DEPRECATED] Mode consumer 在 registry backfill (b58106d0d4) 之前已由 F101 移除 (2dfece9873)；当前 tree 无 live consumer。registry 条目保留，永不进入 curated projection |
| cli | CAT_CAFE_TMUX_AGENT | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | CLI 内部/调试/路径配置 |
| cli | CAT_CAFE_TMUX_PATH | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | CLI 内部/调试/路径配置 |
| cli | CAT_CAFE_DATA_DIR | system | yes | no | read-only | dirpicker | no | N/A | SystemSettingsView.tsx (System Settings page) | 保留 System | 已在 SYSTEM_VARS 中 |
| cli | CAT_CAFE_CALLBACK_TOKEN | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 每 invocation 注入的 callback auth secret，内部运行时身份凭证，不进任何 UI |
| cli | CAT_CAFE_CALLBACK_OUTBOX_ENABLED | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | callback outbox 内部调优 |
| cli | CAT_CAFE_CALLBACK_OUTBOX_DIR | none | yes | no | no UI write | dirpicker | no | none | 无 | 不进 UI | callback outbox 内部调优 |
| cli | CAT_CAFE_CALLBACK_OUTBOX_MAX_ATTEMPTS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | callback outbox 内部调优 |
| cli | CAT_CAFE_CALLBACK_OUTBOX_MAX_FLUSH_BATCH | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | callback outbox 内部调优 |
| cli | CAT_CAFE_CALLBACK_RETRY_DELAYS_MS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | callback outbox 内部调优 |
| cli | CAT_CAFE_CALLBACK_FETCH_TIMEOUT_MS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | callback outbox 内部调优 |
| cli | CDP_DEBUG | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 测试/调试专用 |
| cli | CODEX_HOME | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | CLI home/brain 目录，内部 |
| cli | ANTIGRAVITY_BRAIN_HOME | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | CLI home/brain 目录，内部 |
| cli | CAT_CAFE_API_URL | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入 |
| cli | CAT_CAFE_INVOCATION_ID | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入 |
| cli | CAT_CAFE_CREDENTIAL_FILE | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入 |
| cli | CAT_CAFE_THREAD_ID | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入 |
| cli | CAT_CAFE_CAT_ID | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入 |
| cli | CAT_CAFE_DIAGNOSTICS | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 测试/调试专用 |
| cli | CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 测试/调试专用 |
| cli | CAT_CAFE_PREFLIGHT_TIMEOUT_MS | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| cli | OPENCODE_DB | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 服务/数据库路径，内部 |
| cli | CAT_CAFE_SUPERVISOR_SOCKET_DIR | none | no | no | no UI write | text | no | none | 无 | 不进 UI | CLI 内部/调试/路径配置（supervisor socket dir） |
| cli | CAT_CAFE_PROCESS_OWNER_ID | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入（process owner） |
| cli | CAT_CAFE_PROCESS_EXECUTION_OWNER | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入（execution owner） |
| cli | CAT_CAFE_EXECUTION_ID | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 运行时注入（execution id） |

## Anthropic 代理网关 (6)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| proxy | ANTHROPIC_PROXY_ENABLED | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级网络拓扑选择，与其余 proxy vars 一致，issue #770 allowlist 未列 |
| proxy | ANTHROPIC_PROXY_PORT | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级网络拓扑选择，与其余 proxy vars 一致 |
| proxy | ANTHROPIC_PROXY_UPSTREAMS_PATH | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 上游配置/HTTP_PROXY 等部署级 |
| proxy | HTTPS_PROXY | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 上游配置/HTTP_PROXY 等部署级 |
| proxy | HTTP_PROXY | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 上游配置/HTTP_PROXY 等部署级 |
| proxy | ALL_PROXY | none | no | no | no UI write | text | no | none | 无 | 不进 UI | 上游配置/HTTP_PROXY 等部署级 |

## 平台接入 (Telegram/飞书) (4)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| connector | CONNECTOR_GATEWAY_AUTOSTART | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | runtime 入口授权开关，不能由用户配置 |
| connector | WEIXIN_VOICE_ITEM_MODE | im | yes | yes | read-only, opt-in editable | dropdown | no | none | 无 | 不进 UI | 微信连接器实验开关；不进通用 projection |
| connector | WEIXIN_ENABLE_UNSAFE_VOICE_MODES | im | yes | yes | read-only, opt-in editable | dropdown | no | none | 无 | 不进 UI | 微信连接器实验开关；不进通用 projection |
| connector | WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA | im | yes | yes | read-only, opt-in editable | dropdown | no | none | 无 | 不进 UI | 微信连接器实验开关；不进通用 projection |

## GitHub Review 监控 (14)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| github_review | GITHUB_WEBHOOK_SECRET | plugins | yes | yes | read-only, opt-in editable | text | no | none | 无 | 组件补齐 | GitHub Repo Inbox 配置；需专用组件 UI，不进通用 projection；SECRET 敏感，默认只读，opt-in 可写 |
| github_review | GITHUB_REPO_ALLOWLIST | plugins | yes | no | read-only | text | no | none | 无 | 组件补齐 | GitHub Repo Inbox 配置；需专用组件 UI，不进通用 projection |
| github_review | GITHUB_REPO_INBOX_CAT_ID | plugins | yes | no | read-only | text | no | none | 无 | 组件补齐 | GitHub Repo Inbox 配置；需专用组件 UI，不进通用 projection |
| github_review | GITHUB_AUTHORITATIVE_REVIEW_LOGINS | none | yes | no | no UI write | text | yes | none | 无 | 不进 UI | [DEPRECATED] F140 cutover，description 已标废弃；PR-E 只做 deprecated 标记 + 消费者迁移，registry 物理删除归 maintainer |
| github_review | GITHUB_SETUP_NOISE_BOT_LOGINS | plugins | yes | no | module-managed | text | no | exact | PluginConfigPanel → POST `/api/plugins/github/config` → `.cat-cafe/plugin-config/github.json` → `resolvePluginEnv` → `getGitHubEnvValue` / runtime consumer | 清出 System | 已由 GitHub plugin manifest 覆盖，清出 System 避免双入口 |
| github_review | GITHUB_SELF_LOGIN | plugins | yes | yes | read-only, opt-in editable | text | no | none | 无 | 不进 UI | GitHub / Repo Inbox 配置；不进通用 projection |
| github_review | GITHUB_TOKEN | plugins | yes | no | module-managed | text | no | exact | PluginConfigPanel → POST `/api/plugins/github/config` → `.cat-cafe/plugin-config/github.json` → `resolvePluginEnv` → `getGitHubEnvValue` / runtime consumer | 清出 System | 已由 GitHub plugin manifest 覆盖，清出 System 避免双入口 |
| github_review | GITHUB_REVIEW_IMAP_USER | none | yes | no | no UI write | text | yes | none | 无 | 不进 UI | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR review 反馈现由 register_pr_tracking 驱动的 GitHub API 轮询获取。registry 条目保留，永不进入 curated projection |
| github_review | GITHUB_REVIEW_IMAP_PASS | none | yes | no | no UI write | text | yes | none | 无 | 不进 UI | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR review 反馈现由 register_pr_tracking 驱动的 GitHub API 轮询获取。registry 条目保留，永不进入 curated projection |
| github_review | GITHUB_REVIEW_IMAP_HOST | none | yes | no | no UI write | text | yes | none | 无 | 不进 UI | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR review 反馈现由 register_pr_tracking 驱动的 GitHub API 轮询获取。registry 条目保留，永不进入 curated projection |
| github_review | GITHUB_REVIEW_IMAP_PORT | none | yes | no | no UI write | text | yes | none | 无 | 不进 UI | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR review 反馈现由 register_pr_tracking 驱动的 GitHub API 轮询获取。registry 条目保留，永不进入 curated projection |
| github_review | GITHUB_REVIEW_POLL_INTERVAL_MS | none | yes | no | no UI write | text | yes | none | 无 | 不进 UI | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR review 反馈现由 register_pr_tracking 驱动的 GitHub API 轮询获取。registry 条目保留，永不进入 curated projection |
| github_review | GITHUB_MCP_PAT | plugins | yes | yes | module-managed | text | no | exact | PluginConfigPanel → POST `/api/plugins/github/config` → `.cat-cafe/plugin-config/github.json` → `resolvePluginEnv` → `getGitHubEnvValue` / runtime consumer | 清出 System | 已由 GitHub plugin manifest 覆盖，清出 System 避免双入口 |
| github_review | GITHUB_REVIEW_IMAP_PROXY | none | yes | no | no UI write | text | yes | none | 无 | 不进 UI | [DEPRECATED] IMAP 邮件监控通道已在 v0.9.0 (#596) 移除；PR review 反馈现由 register_pr_tracking 驱动的 GitHub API 轮询获取。registry 条目保留，永不进入 curated projection |

## 缅因猫 (Codex) (8)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex | CAT_CODEX_SANDBOX_MODE | members | yes | no | module-managed | text | no | equivalent | HubCatEditor.tsx → PATCH `/api/config` → ConfigStore → ConfigRegistry/runtime resolver → `CAT_CODEX_SANDBOX_MODE` env fallback | 清出 System | per-cat/全局 Codex 行为配置，已有 HubCatEditor + ConfigStore 覆盖；env 仅作 bootstrap/fallback |
| codex | CAT_CODEX_APPROVAL_POLICY | members | yes | no | module-managed | text | no | equivalent | HubCatEditor.tsx → PATCH `/api/config` → ConfigStore → ConfigRegistry/runtime resolver → `CAT_CODEX_APPROVAL_POLICY` env fallback | 清出 System | per-cat/全局 Codex 行为配置，已有 HubCatEditor + ConfigStore 覆盖；env 仅作 bootstrap/fallback |
| codex | CAT_CAFE_CODEX_CARRIER | members | yes | no | module-managed | dropdown | no | equivalent | HubCatEditor.tsx → PATCH `/api/cats/:id` → cat catalog `cli.carrier` → `resolveCodexCarrier` → `CAT_CAFE_CODEX_CARRIER` env fallback | 清出 System | per-cat carrier 可由 Hub 成员编辑器覆盖；env 仅作 bootstrap/fallback |
| codex | CAT_CAFE_CODEX_OAUTH_TRANSPORT | members | yes | yes | editable | dropdown | no | none | 无 | 不进 UI | per-cat/全局 Codex 行为配置（OAuth transport）；运行行为类，非账号凭证；不进通用 projection |
| codex | CAT_CAFE_CODEX_APP_SERVER_IDLE_TTL_MS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | app-server 内部调优 |
| codex | CAT_CAFE_CODEX_APP_SERVER_MAX_WARM_HOSTS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | app-server 内部调优 |
| codex | CODEX_AUTH_MODE | members | yes | no | module-managed | text | no | equivalent | HubCatEditor.tsx → PATCH `/api/config` → ConfigStore → ConfigRegistry/runtime resolver → `CODEX_AUTH_MODE` env fallback | 清出 System | per-cat/全局 Codex 行为配置，已有 HubCatEditor + ConfigStore 覆盖；env 仅作 bootstrap/fallback |
| codex | OPENAI_API_KEY | accounts | yes | no | module-managed | text | no | equivalent | HubAccountsTab.tsx → `/api/accounts` → accounts/credentials store → account resolver/resolveEnvMap → provider env injection | 清出 System | 由统一账户/凭证系统管理；env 仅作 bootstrap/fallback |

## 暹罗猫 (Gemini) (4)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini | GOOGLE_API_KEY | accounts | no | no | module-managed | text | no | equivalent | HubAccountsTab.tsx → `/api/accounts` → accounts/credentials store → account resolver/resolveEnvMap → provider env injection | 清出 System | 由统一账户/凭证系统管理；env 仅作 bootstrap/fallback |
| gemini | GEMINI_ADAPTER | members | yes | no | read-only | text | no | none | 无 | 不进 UI | Gemini 适配器选择；不进通用 projection |
| gemini | CAT_CAFE_AGY_PROFILE_ROOT | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | AGY profile/cwd 隔离根目录，内部路径 |
| gemini | CAT_CAFE_AGY_CWD_ROOT | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | AGY profile/cwd 隔离根目录，内部路径 |

## Kimi (3)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kimi | MOONSHOT_API_KEY | accounts | no | no | module-managed | text | no | equivalent | HubAccountsTab.tsx → `/api/accounts` → accounts/credentials store → account resolver/resolveEnvMap → provider env injection | 清出 System | 由统一账户/凭证系统管理；env 仅作 bootstrap/fallback |
| kimi | KIMI_SHARE_DIR | none | no | no | no UI write | text | no | none | 无 | 不进 UI | kimi-cli 内部路径 |
| kimi | KIMI_CONFIG_FILE | none | no | no | no UI write | text | no | none | 无 | 不进 UI | kimi-cli 内部路径 |

## 额度监控 (5)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| quota | KIMI_AUTH_TOKEN | ops | no | no | no UI write | text | no | none | 无 | 不进 UI | 额度抓取 token，敏感，建议通过 accounts 注入 |
| quota | KIMI_QUOTA_API_FALLBACK_ENABLED | ops | no | no | no UI write | text | no | none | 无 | 不进 UI | credentials 文件路径，内部 |
| quota | QUOTA_OFFICIAL_REFRESH_ENABLED | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | 官方额度刷新总开关，运维级 |
| quota | CLAUDE_CREDENTIALS_PATH | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | credentials 文件路径，内部 |
| quota | CODEX_CREDENTIALS_PATH | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | credentials 文件路径，内部 |

## 语音合成 (TTS) (4)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tts | TTS_URL | voice | yes | no | read-only | text | no | none | 无 | 产品待决策 | 远程/自托管 sidecar TTS 端点；是否继续支持待产品决策，当前不进任何 projection |
| tts | GENSHIN_VOICE_DIR | voice | yes | no | read-only | dirpicker | no | equivalent | 已有专用模块 UI | 清出 System | 服务端点/缓存目录，服务生命周期 UI 可配置端口/模型，但 URL/dir 级 env 暂无 UI |
| tts | CHARACTER_VOICE_DIR | voice | yes | no | read-only | dirpicker | no | equivalent | 已有专用模块 UI | 清出 System | 服务端点/缓存目录，服务生命周期 UI 可配置端口/模型，但 URL/dir 级 env 暂无 UI |
| tts | LISTEN_MODE_DB | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 听读模式状态数据库（文件路径，非目录）；不进通用 projection |

## 语音识别 (STT) (1)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stt | WHISPER_URL | voice | yes | no | read-only | text | no | none | 无 | 产品待决策 | 远程/自托管 sidecar STT 端点；是否继续支持待产品决策，当前不进任何 projection |

## 前端 (6)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| frontend | NEXT_PUBLIC_API_URL | system | yes | no | no UI write | text | no | none | 无 | 不进 UI | 构建时/前端起始地址，部署级 |
| frontend | NEXT_PUBLIC_WHISPER_URL | voice | yes | no | read-only | text | no | none | 无 | 不进 UI | 服务端点/缓存目录；不进通用 projection |
| frontend | NEXT_PUBLIC_LLM_POSTPROCESS_URL | voice | yes | no | read-only | text | no | none | 无 | 产品待决策 | 远程/自托管 sidecar LLM 后处理端点；是否继续支持待产品决策，当前不进任何 projection |
| frontend | NEXT_PUBLIC_PROJECT_ROOT | system | yes | no | no UI write | text | no | none | 无 | 不进 UI | Next.js 构建期或调试开关 |
| frontend | NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI | system | yes | no | no UI write | text | no | none | 无 | 不进 UI | Next.js 构建期或调试开关 |
| frontend | THEME_CONFIG | frontend | yes | yes | module-managed | text | no | equivalent | F056 Theme Tuner → `themeStore`/localStorage (primary) + PATCH `/api/config/env` (backup) → `restoreFromServer` GET `/api/config/env-summary` → write back to localStorage → `ThemeApplier` reads `themeStore` and `applyThemeCSS` → env fallback | 清出 System | F056 主题系统已有完整 UI 覆盖，当前 runtimeEditable=true，但由模块 UI 管理，清出 System 防双入口 |

## 推送通知 (3)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| push | VAPID_PUBLIC_KEY | notify | yes | no | module-managed | text | no | exact | PushServiceConfig.tsx → POST `/api/config/secrets` → `process.env` / `.env` + `configEventBus` → `configurePushServiceFromEnv` | 清出 System | 已有 PushServiceConfig UI 覆盖 |
| push | VAPID_PRIVATE_KEY | notify | yes | no | module-managed | text | no | exact | PushServiceConfig.tsx → POST `/api/config/secrets` → `process.env` / `.env` + `configEventBus` → `configurePushServiceFromEnv` | 清出 System | 已有 PushServiceConfig UI 覆盖 |
| push | VAPID_SUBJECT | notify | yes | no | module-managed | text | no | exact | PushServiceConfig.tsx → POST `/api/config/secrets` → `process.env` / `.env` + `configEventBus` → `configurePushServiceFromEnv` | 清出 System | 已有 PushServiceConfig UI 覆盖 |

## Signal 信号源 (2)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| signal | SIGNALS_ROOT_DIR | plugins | yes | no | read-only | dirpicker | no | none | 无 | 不进 UI | Signal 插件/信号源配置，暂无 UI |
| signal | CAT_CAFE_SIGNAL_USER | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | Signal MCP 运行身份绑定，身份锚点类；比照 DEFAULT_OWNER 处理原则，暂不给 UI 编辑面 |

## F102 记忆系统 (19)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| evidence | EMBED_MODE | ops | yes | no | read-only | dropdown | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F102_ABSTRACTIVE | ops | yes | no | read-only | text | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F102_DURABLE_CANDIDATES | ops | yes | no | read-only | text | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F102_TOPIC_SEGMENTS | ops | yes | no | read-only | text | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F200_CONSUMPTION_RERANK | ops | yes | yes | editable | dropdown | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F163_AUTHORITY_BOOST | ops | yes | yes | editable | dropdown | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F163_ALWAYS_ON_INJECTION | ops | yes | yes | editable | dropdown | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F163_RETRIEVAL_RERANK | ops | yes | yes | editable | dropdown | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F163_COMPRESSION | ops | yes | yes | editable | dropdown | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F163_PROMOTION_GATE | ops | yes | yes | editable | dropdown | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F163_CONTRADICTION_DETECTION | ops | yes | yes | editable | dropdown | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F163_REVIEW_QUEUE | ops | yes | yes | editable | dropdown | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | EMBED_URL | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 服务/数据库路径，内部 |
| evidence | GLOBAL_KNOWLEDGE_DB | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 服务/数据库路径，内部 |
| evidence | TASK_OUTCOME_DB | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 服务/数据库路径，内部 |
| evidence | EVENT_MEMORY_DB | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 服务/数据库路径，内部 |
| evidence | F102_API_BASE | ops | yes | no | read-only | text | no | equivalent | 已有专用模块 UI | 清出 System | F102/F163/F200 实验开关；已有专用模块 UI，不进通用 projection |
| evidence | F102_API_KEY | accounts | yes | yes | read-only, opt-in editable | text | no | equivalent | 已有专用模块 UI | 清出 System | future accounts migration 是目标，但 summarizer 当前仍直接读 process.env；当前 runtimeEditable=true，PR-C 默认只读 + opt-in 可写；consumer cutover 完成前 env fallback 保留 |
| evidence | EMBED_PORT | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 服务/数据库路径，内部 |

## 可观测性 (OTel) (12)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| telemetry | TELEMETRY_DEBUG | ops | no | no | no UI write | text | no | none | 无 | 不进 UI | 调试遥测，仅限 dev/test |
| telemetry | TELEMETRY_DEBUG_FORCE | ops | no | no | no UI write | text | no | none | 无 | 不进 UI | 调试遥测，仅限 dev/test |
| telemetry | TELEMETRY_HMAC_SALT | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级可观测性配置 |
| telemetry | TELEMETRY_EXPORT_RAW_SYSTEM_IDS | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级可观测性配置 |
| telemetry | PROMETHEUS_PORT | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级可观测性配置 |
| telemetry | OTEL_EXPORTER_OTLP_ENDPOINT | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级可观测性配置 |
| telemetry | OTEL_SDK_DISABLED | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级可观测性配置 |
| telemetry | TELEMETRY_ALERT_ERROR_RATE | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级可观测性配置 |
| telemetry | TELEMETRY_ALERT_P95_LATENCY_S | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级可观测性配置 |
| telemetry | TELEMETRY_ALERT_ACTIVE_INVOCATIONS | ops | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署级可观测性配置 |
| telemetry | PROMPT_CAPTURE | ops | yes | yes | editable | dropdown | no | equivalent | 已有专用模块 UI | 清出 System | Prompt X-Ray 开关；已有专用模块 UI，不进通用 projection |
| telemetry | PROMPT_CAPTURE_CATS | ops | yes | yes | editable | text | no | equivalent | 已有专用模块 UI | 清出 System | Prompt X-Ray 开关；已有专用模块 UI，不进通用 projection |

## 孟加拉猫 (Antigravity) (13)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| antigravity | ANTIGRAVITY_PORT | mcp | yes | no | no UI write | text | no | none | 无 | 不进 UI | 自动发现，通常无需配置 |
| antigravity | PINCHTAB_CDP_PORT | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| antigravity | ANTIGRAVITY_CSRF_TOKEN | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| antigravity | ANTIGRAVITY_TLS | mcp | yes | no | no UI write | text | no | none | 无 | 不进 UI | 自动发现，通常无需配置 |
| antigravity | ANTIGRAVITY_AUTO_APPROVE | mcp | yes | no | no UI write | text | no | none | 无 | 不进 UI | Antigravity 执行策略，内部/高级 |
| antigravity | ANTIGRAVITY_AUTO_RESUME | mcp | yes | no | no UI write | text | no | none | 无 | 不进 UI | Antigravity 执行策略，内部/高级 |
| antigravity | ANTIGRAVITY_YOLO_RUN_COMMAND | mcp | yes | no | no UI write | text | no | none | 无 | 不进 UI | Antigravity 执行策略，内部/高级 |
| antigravity | ANTIGRAVITY_RUN_COMMAND_TIMEOUT_MS | mcp | yes | no | no UI write | text | no | none | 无 | 不进 UI | Antigravity 内部路径/端口 |
| antigravity | ANTIGRAVITY_TRACE_RAW | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 测试/调试专用 |
| antigravity | ANTIGRAVITY_NATIVE_EXECUTOR | mcp | yes | no | no UI write | text | no | none | 无 | 不进 UI | Antigravity 执行策略，内部/高级 |
| antigravity | CAT_CAFE_RIPGREP_PATH | mcp | yes | no | no UI write | text | no | none | 无 | 不进 UI | Antigravity 内部路径/端口 |
| antigravity | CAT_CAFE_READONLY | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |
| antigravity | CAT_CAFE_RUNTIME_SESSION_SEAL_REAPER_INTERVAL_MS | none | yes | no | no UI write | text | no | none | 无 | 不进 UI | 部署/内部专用 |

## 会中实时智囊 (F195) (2)

| category | var name | section target | registry summary eligible? | current editable | target write policy | control type | dead config? | 覆盖类型 | 现有 UI 覆盖 | disposition | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| audio | AUDIO_SERVICE_URL | voice | yes | no | read-only | text | no | none | 无 | 产品待决策 | 远程/自托管 sidecar 音频服务端点；是否继续支持待产品决策，当前不进任何 projection |
| audio | TRANSCRIPT_DIR | voice | yes | no | read-only | dirpicker | no | none | 无 | 不进 UI | 服务端点/缓存目录；不进通用 projection |

## Summary

- **Total env vars inventoried**: 218
- **保留 System** (真正 system-level 配置，保留在 System view): 28
- **清出 System** (已有模块 UI 覆盖，从 System view 移除): 34
- **投影到模块** (无 UI 覆盖且用户确需配置): **0**（PR-A 清空，等 PR-C 按模块 owner 确认后重新添加）
- **组件补齐** (需专用组件/连接器扩展，不进通用 env 卡): 4
- **产品待决策** (是否继续支持远程/自托管 sidecar，待产品决策): 4
- **不进 UI** (部署级 / 内部 / 测试 / deprecated / 无当前 UI 路径): 148
- **未分类 items**: 0（sol 在 HEAD `f790c4ed2` 完成源码审计，结论：之前的 42 项 generic projection 不成立）

> **PR-A 关键修正**：原 42 项“投影到模块”结论已被撤销。
> 其中 18 项已有专用模块 UI（evidence/F102/F163/F200 实验开关、Prompt X-Ray、语音模型目录），应原地修复专用页面；
> 24 项为平台管理/内部调优/重复入口/条件性缺口/需组件级扩展，不应直接进入通用 env 卡。
> `packages/api/src/config/env-sections.ts` 的 `MODULE_SECTION_PROJECTION` 在 PR-A 中全部置空，保留 section/filter/write-policy 基础设施；真正的模块投影将在 PR-C 中随各模块 UI 负责人确认后收敛。

### Invariants

- **保留 System** ⇒ `section target` 必须为 `system`；这些 vars 必须保留在 `SYSTEM_VARS`。
- **清出 System** ⇒ `覆盖类型` 必须为 `exact` 或 `equivalent`；这些 vars 必须从 `SYSTEM_VARS` 移除且不进任何 module projection。
- **投影到模块** ⇒ `覆盖类型` 必须为 `none` 且 `section target` 必须是非 `system` 的模块；这些 vars 进入对应 module projection。PR-A 中该集合为空。
- **不进 UI** ⇒ `覆盖类型` 必须为 `none`（保留 System 除外，记 `N/A`）；这些 vars 不得进入 `SYSTEM_VARS` 或任何 module projection。
- **组件补齐** ⇒ 需后续专用组件/连接器 UI 承载，不进通用 env 投影；PR-C 前不得进入 `MODULE_SECTION_PROJECTION`。
- **产品待决策** ⇒ 是否继续支持对应功能待产品决策；决策前不得进入 `MODULE_SECTION_PROJECTION`。
- Vars with `deprecated: true` metadata ⇒ 永远不得进入 `SYSTEM_VARS` 或任何 module projection（PR-A `filterEnvSummaryForSection` 已 enforce）。Description-only deprecated markers（如 #1340 中的 `GITHUB_AUTHORITATIVE_REVIEW_LOGINS`）不会被 filter 自动拦截，必须从 projection set 显式移除；完整 metadata 标记与消费者迁移归 PR-E。

## PR Split Proposal (after PR-A)

### PR-B: System view cleanup + consolidated retention
- Scope:
  - Keep in `SYSTEM_VARS` all vars marked **保留 System** (the 28 true system-level knobs: ports, storage paths, TTL, security boundaries).
  - Remove from `SYSTEM_VARS` and `SystemSettingsView.tsx` only vars marked **清出 System** (those already covered by module UI).
  - Move sensitive credentials already covered by accounts/credentials UI (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `MOONSHOT_API_KEY`) to accounts.
  - Remove credentials already covered by plugin manifests (`GITHUB_TOKEN`, `GITHUB_MCP_PAT`, `GITHUB_SETUP_NOISE_BOT_LOGINS` via `packages/api/src/plugins/github/plugin.yaml`) from the generic System/accounts surface; leave internal-only secrets (`CAT_CAFE_CALLBACK_TOKEN`) hidden, not in accounts.
- Dependencies: PR-A (unified env renderer foundation) must land first.
- Verification: `GET /api/config/env-summary?surface=system` returns only true system-level knobs; no duplicated VAPID/connector/plugin fields.

### PR-C: Project env vars to module pages (TBD — 等 UI owner 确认)
- Scope: for each module, add a "环境变量" subsection using the unified env renderer to surface vars that are **确实没有** dedicated module UI 且 **产品决定** 要暴露的 env vars.
- Ownership gate: 每个模块在重新向 `MODULE_SECTION_PROJECTION` 添加变量之前，必须确认该变量在现有模块页面中无等价入口，且应由通用 env renderer 而非组件内嵌字段承载。
- Candidate categories from sol's audit (not yet approved for projection):
  - **已有专用 UI，应修复原页面**：18 项 evidence/F102/F163/F200 实验开关、`PROMPT_CAPTURE*`、`CHARACTER_VOICE_DIR`、`GENSHIN_VOICE_DIR`。
  - **组件补齐**（需专用组件/连接器扩展，不进通用 env 卡）：`AUDIT_LOG_INCLUDE_PROMPT_SNIPPETS`；GitHub Repo Inbox 配置（`GITHUB_WEBHOOK_SECRET`、`GITHUB_REPO_ALLOWLIST`、`GITHUB_REPO_INBOX_CAT_ID`），但需先把 connector gateway 从直接读 `process.env` 迁到 plugin config resolver。
  - **产品待决策**（仅当产品继续支持远程/自托管 sidecar 时，在 `ServiceStatusPanel` 增加“自定义端点”）：`AUDIO_SERVICE_URL`、`TTS_URL`、`WHISPER_URL`、`NEXT_PUBLIC_LLM_POSTPROCESS_URL`。
- Dependencies: PR-B (so System view no longer duplicates them).
- Runtime-persistence caveat: Console `PATCH /api/config/env` writes per-user `.env` and mutates the running process, but packaged desktop restart (`ServiceManager._startApi()`) does not reload `.env` (tracked by #1062). PR-C full acceptance for the packaged desktop lane is blocked on #1062; dev-mode acceptance can proceed. `LOG_LEVEL` is the canonical regression sample.
- Write-policy gate: all projected vars are readable; write is only enabled when the var's **target write policy** is `editable` **and** the runtime persistence contract is satisfied.
- Verification: each module page can read its projected env vars via the unified renderer; only vars marked `editable` in target write policy are writable; `runtimeEditable=false` / `read-only` / `read-only, opt-in editable` vars render as read-only; build-time vars (`NEXT_PUBLIC_*`) are surfaced read-only with a rebuild-required hint. e2e tests verify no regressions in existing module UIs.

### PR-D: Hide internal/deploy/test vars
- Scope: ensure all vars marked **不进 UI** have `hubVisible: false` (or are omitted from `buildEnvSummary`) and do not appear in any renderer.
  - Vars marked **组件补齐** or **产品待决策** are intentionally excluded from this hide rule; they are expected to enter dedicated component UI once their respective owner/scope is resolved.
- Add lint/rule: new internal-only vars must declare `hubVisible: false` and a justification comment.
- Dependencies: PR-C (so projection surface is stable before we narrow visibility).
- Verification: `buildEnvSummary()` no longer returns deploy/internal/test vars; snapshot test updated.

### PR-E: Deprecated cleanup
- Scope: formally deprecate `GITHUB_AUTHORITATIVE_REVIEW_LOGINS`; migrate any remaining consumers to `GITHUB_SETUP_NOISE_BOT_LOGINS`.
- Dependencies: PR-D (visibility cleanup first).
- Verification: no runtime reads of dead config; registry entry retained per maintainer policy—physical removal is maintainer-owned, not done in this PR.

### PR-A sync delta (applied at HEAD `f790c4ed2`)

PR-A previously carried a 42-var module projection. After sol's source audit on HEAD `f790c4ed2` the projection conclusion was retracted:

- **Current projection in PR-A**: 0 vars across the 7 non-system sections (`accounts`, `im`, `members`, `notify`, `ops`, `plugins`, `voice`).
- **Reason**: the prior 42-var allowlist conflated five distinct categories:
  1. 18 vars already have dedicated module UI and should be fixed in-place, not duplicated in a generic env card.
  2. 15 vars are platform-management, internal tuning, or escape-hatch knobs and should not appear in normal user UI.
  3. 1 var (`NEXT_PUBLIC_WHISPER_URL`) is a duplicate legacy entry.
  4. 4 vars need component-level extensions rather than generic projection (**组件补齐**).
  5. 4 vars are conditional gaps that only make sense if the product keeps supporting remote/self-hosted sidecars (**产品待决策**).

**Structural changes to `packages/api/src/config/env-sections.ts`:**
- Keep `plugins` in `EnvSectionKey`, `ENV_SECTION_KEYS`, and `ENV_SECTION_LABELS`.
- Remove `mcp` and `concierge`; they had no planned module UI in PR-C.
- Keep `accounts` in the section type/key/label set for future PR-C use.
- `MODULE_SECTION_PROJECTION` is intentionally empty in PR-A. It remains the only source of truth for which non-system vars appear in which section; ownership metadata in the registry must **not** be interpreted as an automatic projection.

**Verification:** `MODULE_SECTION_PROJECTION` contains exactly 0 vars in every non-system section; the unit test asserts this. `SYSTEM_VARS` and section keys/labels remain unchanged. Deprecated vars continue to be excluded from all section summaries.
