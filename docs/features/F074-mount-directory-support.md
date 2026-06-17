---
feature_ids: [F074]
related_features: [F063, F068]
topics: [project-path, security, mount, shared-directory]
doc_kind: spec
created: 2026-03-07
completed: 2026-03-11
status: done
---

# F074: Mount Directory Support — 挂载/共享目录支持

> **Status**: done | **Owner**: Ragdoll
**Completed: 2026-03-11**
**Implementation**: PR #273 (`3c067fd3`)
> **Evolved from**: F068（新建对话 UX）

## Why

operator通过共享目录（SMB/NFS）将同事电脑挂载到本机，想在挂载目录下直接与猫猫协作。当前后端 `validateProjectPath` 的 allowlist 默认只含 `$HOME`、`/tmp`、`/private/tmp`，不包含 `/Volumes`，导致所有挂载目录被 403 拒绝。`PROJECT_ALLOWED_ROOTS` 环境变量是覆盖模式（非追加），配置成本高且容易丢失默认值。前端文案写"选择任意目录"但实际受限，体验不一致。

## What

让用户可以在目录选择器中选择挂载/共享目录，同时保持路径安全校验与既有部署的安全边界兼容。

### 改动范围

1. **默认 roots 加入 `/Volumes`**：macOS 挂载卷的标准路径，默认配置下可直接选择挂载目录
2. **保留 `PROJECT_ALLOWED_ROOTS` 覆盖语义**：已有部署继续显式收敛 allowlist，不会因升级意外放宽边界
3. **新增 `PROJECT_ALLOWED_ROOTS_APPEND=true`**：需要时显式 opt-in 追加模式，把自定义 roots 合并到默认 roots
4. **结构化错误响应**：403 返回 `{ error, selectedPath, allowedRoots }`，方便前端展示和调试
5. **前端/配置说明修正**：目录选择文案和 env 说明与真实行为一致

## Acceptance Criteria

- [x] AC-A1: 本文档需在本轮迁移后维持模板核心结构（Status/Why/What/Dependencies/Risk/Timeline）。
- [x] AC1: `/Volumes/xxx` 路径通过 `validateProjectPath` 校验（默认配置下）
- [x] AC2: `PROJECT_ALLOWED_ROOTS` 默认保持覆盖模式（向后兼容）
- [x] AC3: `PROJECT_ALLOWED_ROOTS_APPEND=true` 时可显式追加默认 roots
- [x] AC4: 403 错误返回结构化 JSON（含 `selectedPath` 和 `allowedRoots`）
- [x] AC5: 前端文案准确反映实际行为，env 说明同步到最终语义
- [x] AC6: 相关回归测试通过（`project-path` / `pick-directory`）

## 需求点 Checklist

| ID | 需求 | AC# | 验证方式 | 状态 |
|----|------|-----|---------|------|
| R1 | 挂载目录可被选为项目路径 | AC1 | test | [x] |
| R2 | 既有 env 覆盖语义保持不变 | AC2 | test | [x] |
| R3 | 追加模式可显式启用 | AC3 | test | [x] |
| R4 | 结构化错误响应 | AC4 | test | [x] |
| R5 | 前端文案/配置说明准确 | AC5 | manual | [x] |
| R6 | 回归测试通过 | AC6 | test | [x] |

## Key Decisions

- `/Volumes` 加入默认 allowlist（macOS 标准挂载点）
- 兼容性优先于便利性：`PROJECT_ALLOWED_ROOTS` 保持覆盖语义，追加模式改为显式 opt-in（`PROJECT_ALLOWED_ROOTS_APPEND=true`）
- 结构化错误字段使用 `selectedPath`，避免把原始用户选择路径误写成 canonical realpath

## Dependencies

- **Related**: F063/F068（workspace explorer + new-thread UX）
- 无硬依赖

## Risk

- Low：改动集中在 path 校验工具与目录选择链路，影响面可控
- `/Volumes` 白名单扩大了默认允许范围，但 env 覆盖语义保持不变，已有收敛配置不会被意外放宽

## Review Gate

- 跨家族 review（Maine Coon优先）
- 云端 Codex review
