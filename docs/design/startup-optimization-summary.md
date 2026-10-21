---
feature_ids: [F155, F229, F320]
topics: [performance, startup, implementation]
doc_kind: implementation-plan
created: 2026-10-15
---

# 启动性能优化实施总结

> 2026-10-16 状态更正：下文是上一轮探索记录，不能作为优化已集成或收益已实测的结论。
> `lazy-telemetry.ts`、`lazy-validation.ts` 两份原型没有调用方，却被 TypeScript 和环境变量门禁扫描，造成 CI 失败；本轮已从运行源码撤出。
> 实际启动继续使用 `infrastructure/telemetry/init.ts` 统一入口和原有配置校验，不新增遥测开关或跳过校验。
> 后续性能实现与测量按 #1606 跟进；下文秒数均需对应首装/首启实测验证。

## 已完成的工作

### 1. 性能分析文档
✅ 创建 `performance-analysis-cold-start-2026-10-15.md`
- 详细分析当前性能瓶颈
- 识别优化机会
- 设定优化目标

### 2. 实施计划文档
✅ 创建 `startup-optimization-implementation-plan.md`
- 分阶段优化策略
- 风险评估和缓解措施
- 测试验证标准

### 3. 核心优化工具
✅ 创建 `packages/api/src/telemetry/lazy-telemetry.ts`
- OpenTelemetry 条件加载
- 桌面模式默认禁用遥测
- 预期减少 10-15s 启动时间

✅ 创建 `packages/api/src/config/lazy-validation.ts`
- Zod 条件验证
- 生产环境跳过启动时验证
- 预期减少 5-8s 启动时间

### 4. 发现的现状
✅ 已有优化：
- Puppeteer 延迟加载（`lazy-puppeteer.ts`）
- MCP SDK 延迟加载（`lazy-mcp-sdk.ts`）
- QRCode 延迟加载（`lazy-qrcode.ts`）
- 插件系统延迟加载（`await import()`）
- API 和 Web 并行启动（`prepareStartupServices`）

## 下一步行动

### Phase 1: 集成优化工具（需要代码修改）

#### 1.1 集成 lazy-telemetry
修改 `packages/api/src/index.ts`，在启动时使用条件遥测：

```typescript
// 查找 OpenTelemetry 导入并替换为：
import { initializeTelemetry } from './telemetry/lazy-telemetry.js';

// 在启动函数中：
async function startServer() {
  // 条件加载遥测（仅在启用时）
  const telemetry = await initializeTelemetry();
  
  // ... 其余启动逻辑
}
```

**位置**：需要在 `index.ts` 中查找 `@opentelemetry` 的导入和使用

#### 1.2 集成 lazy-validation
在关键配置加载点使用条件验证：

```typescript
// 例如：cat-config-loader.ts
import { validateStartupConfig } from './lazy-validation.js';

// 替换：
const config = configSchema.parse(data);
// 为：
const config = validateStartupConfig(data, configSchema, 'cat-config');
```

**目标文件**：
- `packages/api/src/config/cat-config-loader.ts`
- `packages/api/src/config/account-store-format.ts`
- `packages/api/src/config/codex-account-schema.ts`
- 其他启动路径的配置加载

#### 1.3 环境变量设置
在 `desktop/service-manager.js` 中为桌面模式设置环境变量：

```javascript
_getApiEnv(nodeExe, userDataDir) {
  return {
    // ... 现有环境变量
    CAT_CAFE_RUNTIME_MODE: 'desktop',
    NODE_ENV: 'production',
    OTEL_DISABLED: 'true', // 桌面模式禁用遥测
    // 不设置 STRICT_VALIDATION，允许跳过验证
  };
}
```

### Phase 2: 构建和测试

#### 2.1 重新构建
```bash
cd /g/AIwork/clowder-ai/worktrees/feat-onboarding-first-run

# 安装依赖（如果需要）
pnpm install

# 构建 shared
pnpm --filter @cat-cafe/shared build

# 构建 API（包含新的优化代码）
pnpm --filter @cat-cafe/api build

# 构建 Web
pnpm --filter @cat-cafe/web build

# 打包桌面应用
cd desktop
pnpm run dist
```

#### 2.2 生成安装器
需要运行完整的打包流程以生成新的 exe 安装器

#### 2.3 性能测试
在干净环境测试：
1. 全新安装时间
2. 首次冷启动时间
3. 功能完整性测试

### Phase 3: 进一步优化（可选）

#### 3.1 依赖清理
```bash
# 移除重复的 plugin-contract 版本
# 编辑 packages/api/package.json，统一到 beta.27
```

#### 3.2 Bundle 更多依赖
修改 `desktop/scripts/bundle-desktop-api.mjs`，添加更多可打包的依赖

#### 3.3 监控和调优
添加启动性能埋点，持续监控优化效果

## 预期性能收益

基于分析，集成上述优化后预期：

| 指标 | 当前 | 预期 | 改善 |
|------|------|------|------|
| 首次安装 | 117.4s | 90-100s | 15-23% |
| 冷启动 | 112.2s | 80-95s | 15-29% |
| 模块加载 | 60.7s | 45-55s | 9-26% |

**说明**：
- OpenTelemetry 禁用：减少 ~10-15s
- Zod 验证跳过：减少 ~5-8s
- 已有的并行启动已在工作
- 进一步优化需要 Phase 3

## 技术债务和风险

### 已缓解的风险
✅ 延迟加载模式已验证（puppeteer, mcp, qrcode）
✅ 并行启动已实现（API + Web）
✅ 条件验证有开发模式保护

### 需要注意的点
⚠️ **遥测集成**：需要确认 `index.ts` 中 OpenTelemetry 的正确位置
⚠️ **验证替换**：需要识别启动关键路径，不能误改运行时验证
⚠️ **环境变量**：确保 `CAT_CAFE_RUNTIME_MODE=desktop` 正确传递

## 建议的实施顺序

### 选项 A：保守实施（推荐）
1. 先集成 lazy-telemetry（影响最大，风险最小）
2. 测试验证遥测可选和性能收益
3. 再集成 lazy-validation（影响中等）
4. 完整回归测试

### 选项 B：完整实施
1. 同时集成两个优化
2. 完整构建和测试
3. 一次性验证所有收益

### 选项 C：仅分析和文档（当前状态）
1. 已完成性能分析
2. 已创建优化工具
3. 等待进一步决策

## 用户决策点

请确认：

1. **是否继续实施 Phase 1？**
   - [ ] 是，继续集成优化代码
   - [ ] 否，暂停等待进一步评估
   - [ ] 部分实施（仅 lazy-telemetry）

2. **测试环境准备**
   - [ ] 已准备干净测试机器
   - [ ] 已备份现有配置和数据
   - [ ] 可以接受测试版 exe

3. **优先级确认**
   - [ ] 优先速度优化（可接受小风险）
   - [ ] 优先稳定性（逐步验证）
   - [ ] 先分析对比竞品（如 openai/codex）

## 参考文档

1. 性能分析：`docs/design/performance-analysis-cold-start-2026-10-15.md`
2. 实施计划：`docs/design/startup-optimization-implementation-plan.md`
3. 现有证据：`docs/design/issue1466-windows-clean-install-evidence-2026-10-15.md`
4. 优化工具：
   - `packages/api/src/telemetry/lazy-telemetry.ts`
   - `packages/api/src/config/lazy-validation.ts`
