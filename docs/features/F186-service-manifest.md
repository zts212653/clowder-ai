---
feature_ids: [F186]
related_features: [F179]
topics: [service-management, ml-services, autostart, infrastructure]
doc_kind: feature-spec
created: 2026-05-06
---

# F186: Service Manifest — ML 服务统一管理

> **Status**: doing | **Owner**: 布偶猫/宪宪
> **Priority**: P2
> **Evolved from**: F179 console 重构中抽出的独立子系统

## 愿景

ML sidecar 服务（ASR/TTS/Embedding/LLM后修）从 start-dev.sh 的硬编码脚本管理，迁移到声明式 manifest + API 驱动的统一管理。铲屎官通过 Settings UI 安装、启停、切换模型，不需要手动编辑 .env 或跑脚本。

## What

### 已完成

#### 声明层
- `ServiceManifest` 类型定义：id/name/type/port/prerequisites/scripts/enablesFeatures/configVars
- `ServiceConfig` 持久化配置：enabled/selectedModel/port → `.cat-cafe/services.json`
- `ServiceState` 运行时状态：manifest + status + installed + enabled + healthDetail
- `MODEL_ENV_VARS` 映射：服务 ID → 模型环境变量名

#### 运行时
- `service-registry.ts`：已知服务列表、安装检测、健康探测、状态查询
- `service-config.ts`：配置读写（支持 `CAT_CAFE_SERVICES_CONFIG` env override 用于测试隔离）
- `service-autostart.ts`：API 启动后自动拉起 enabled 服务，带状态日志

#### API 路由
- `GET /api/services` — 列出所有服务及状态
- `GET /api/services/:id/health` — 单服务健康探测（无需 owner 鉴权）
- `POST /api/services/:id/toggle` — 启停服务（owner-only + model ID 注入防护）
- `POST /api/services/:id/install` — 安装服务（owner-only + model ID 验证）

#### 前端
- `ServiceStatusPanel` — 设置页服务状态面板
- 启动脚本迁移：`scripts/services/` 目录（install/start/stop/uninstall per service）

### 待做

- [ ] 健康轮询：���时探测已启用服务的 health endpoint，更新 ServiceState
- [ ] 日志流：服务启动/运行日志通过 WebSocket 推送到前���
- [ ] 依赖排序：服务间依赖声明 + 启动顺序保证
- [ ] 模型下载进度：安装过程中模型下载进度反馈
- [ ] 卸载弹窗：卸载时提供选项"同时删除模型缓存"（HuggingFace cache ~数十GB），默认仅删 venv

### Phase 4: 新功能接入规范（从 F179 迁入）

#### 4a. Feature Placement Decision Tree

```
新功能上线：
├─ 用户每天用? → L1 Activity Bar（极慎重，当前仅 4 个）
├─ 管理/配置? → L2 /settings 分区
├─ 只读/分析? → L3 /settings 子 tab
└─ 特殊场景? → L4 独立路由

有外部依赖? → 注册 ServiceManifest，声明安装/启停脚本
有配置项? → env-registry 注册，标记 restartRequired + group
有 MCP? → 通过 MCP 管理安装，env vars 可编辑
有 IM 连接? → IM 对接分区添加配置卡片
```

#### 4b. 新扩展服务接入 SOP

1. 在 `service-manifests/` 目录创建 `{service-id}.json`
2. 编写安装/启停脚本放入 `scripts/`
3. 在 env-registry.ts 注册相关环境变量
4. 在对应的设置分区（MCP/Skill/语音/记忆）内联 Service Manifest 状态组件
5. 如果服务启用条件影响 UI 展示（如语音按钮），在前端添加条件判断

#### 4c. 新功能入口接入 SOP

1. 确定功能层级（L1-L4）
2. 如果是 L2，确定归属的 /settings 分区
3. 创建组件，复用 Settings 页面的布局框架
4. 在 settings 导航配置中注册新分区/tab
5. 不新增顶栏按钮或侧边栏按钮（除非经铲屎官批准升级为 L1）

## Acceptance Criteria

- [x] AC-1: ML 服务通过 manifest 声明，不在 start-dev.sh 硬编码
- [x] AC-2: 服务启停通过 API + Settings UI 操作，owner-only 鉴权
- [x] AC-3: model ID 输入验证，防止 shell/python 注入
- [x] AC-4: 测试不污染真实 `.cat-cafe/services.json`（CAT_CAFE_SERVICES_CONFIG env override）
- [x] AC-5: API 启动后自动拉起 enabled 服务，日志可见
- [x] AC-6: 卸载流程：前端 UI 支持卸载已安装服务（uninstall 按钮 + API）
- [ ] AC-7: 健康轮询 + 前端实时状态刷新
- [ ] AC-8: 服务日志流推送
- [ ] AC-9: Feature Placement Decision Tree 文档化并纳入 SOP
- [ ] AC-10: 新扩展服务接入 SOP 文档化
- [ ] AC-11: 至少 1 个新功能按新规范接入验证

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 配置路径可通过 env override | 测试隔离必须，防止测试写真实服务配置 | 2026-05-06 |
| KD-2 | 脚本放 `scripts/services/` 统一管理 | 与旧 `scripts/*.sh` 分离，每服务 install/start/stop/uninstall 四件套 | 2026-05-06 |
| KD-3 | start-dev.sh 移除旧 sidecar 启动块 | 由 service-autostart 接管，避免重复启动 | 2026-05-06 |
| KD-4 | health endpoint 不要求 owner 鉴权 | 只读探测，前端状态面板需要无 owner 也能显示 | 2026-05-06 |

## Dependencies

- **Parent**: F179（Console 架构重构 — 原始 Settings 页面中的服务管理 UI）
- **Related**: 语音相关 feature（ASR/TTS 服务是 F180 管理的对象）
