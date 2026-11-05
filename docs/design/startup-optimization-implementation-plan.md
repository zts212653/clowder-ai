---
feature_ids: [F155, F229, F320]
topics: [performance, startup, implementation]
doc_kind: implementation-plan
created: 2026-10-15
---

# 启动优化实施计划

> 2026-10-16 状态更正：下文保留候选方案，不代表实际收益或已接入行为。
> 未接入的 `lazy-telemetry.ts` 和 `lazy-validation.ts` 原型已因编译/环境变量检查失败从运行源码撤出；不按下文示例绕过配置校验或新增第二套遥测 SDK。
> 后续实现应复用统一遥测入口，保留配置校验和既有可观测性，收益通过 #1606 的实际首装/首启验证。

## 现状分析

### 已实施的优化
✅ **Puppeteer 延迟加载** - 使用 `lazy-puppeteer.ts`
✅ **插件系统延迟加载** - line 4850-4865 使用 `await import()`
✅ **MCP SDK 延迟加载** - 使用 `lazy-mcp-sdk.ts`
✅ **QRCode 延迟加载** - 使用 `lazy-qrcode.ts`

### 主要瓶颈（按影响排序）

1. **模块读取瓶颈（50.9s / 45%）**
   - 3,275 次模块加载
   - 82,919 个文件需要解压
   - 问题：过多的小文件 I/O

2. **依赖树膨胀（68,629 公共依赖文件）**
   - OpenTelemetry：24个文件导入
   - zod：317次导入
   - ajv：5个版本（plugin-contract beta21/23/24/25/27）
   - 多余的依赖版本

3. **串行启动（~15-20s）**
   - Redis → API → Web 串行启动
   - 无并行预热

## 优化策略（按优先级）

### Phase 1: 快速收益项（本次实施）

#### 1.1 OpenTelemetry 条件加载 ⭐⭐⭐
**影响**: 减少 10-15s 启动时间
**实施**: 仅在配置启用时加载遥测

```typescript
// packages/api/src/telemetry/lazy-telemetry.ts
export const loadTelemetry = async () => {
  const enabled = process.env.OTEL_ENABLED === 'true';
  if (!enabled) {
    return { nodeSDK: null, registerShutdown: () => {} };
  }
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  // ... 初始化
};
```

#### 1.2 服务并行启动 ⭐⭐⭐
**影响**: 减少 8-12s 启动时间
**实施**: 修改 `service-manager.js`

```javascript
async _startAll() {
  const nodeExe = resolveNode(this.root);
  
  // 并行启动 Redis 和 API 预热
  const [redisProc] = await Promise.all([
    this.timeline.runPhase('redis', () => this._startRedis()),
    this._prebuildAPIResources() // 预加载共享模块
  ]);
  
  // API 启动时轮询 Redis ready
  const [apiProc, webProc] = await Promise.all([
    this.timeline.runPhase('api', () => this._startAPI({ waitRedis: true })),
    this._prebuildWebAssets()
  ]);
  
  await this._waitForAPIReady();
  return { redis: redisProc, api: apiProc, web: webProc };
}
```

#### 1.3 Zod 验证条件化 ⭐⭐
**影响**: 减少 5-8s 启动时间
**实施**: 生产环境跳过启动时的 schema 验证

```typescript
// packages/api/src/config/lazy-validation.ts
const SKIP_VALIDATION = process.env.NODE_ENV === 'production' 
  && !process.env.STRICT_VALIDATION;

export const validateConfig = (data: unknown, schema: z.ZodSchema) => {
  if (SKIP_VALIDATION) {
    return data; // 信任已验证的配置
  }
  return schema.parse(data);
};
```

**预期收益**: 25-35s 减少（首启从 112s → 77-87s）

### Phase 2: 依赖优化（下次迭代）

#### 2.1 移除重复 plugin-contract 版本
**问题**: 5个版本的 ajv + ajv-formats

```json
// 统一到最新版本
"@clowder-ai/plugin-contract": "0.1.0-beta.27"
// 移除 beta21/23/24/25
```

#### 2.2 Bundle OpenTelemetry
**方案**: 将 OTel 打包进 API bundle

```javascript
// desktop/scripts/bundle-desktop-api.mjs
const bundledDependencies = new Set([
  // ... 现有
  '@opentelemetry/sdk-node',
  '@opentelemetry/api',
  // 所有 @opentelemetry/* 包
]);
```

#### 2.3 替换 zod 为轻量级方案
**探索**: 运行时类型检查 vs 构建时验证

### Phase 3: 架构优化（后续）

#### 3.1 V8 Snapshot / Bytecode Cache
#### 3.2 增量安装
#### 3.3 预编译模块

## 实施步骤（本次会话）

### Step 1: OpenTelemetry 延迟加载
- [ ] 创建 `lazy-telemetry.ts`
- [ ] 修改 `index.ts` 中的 OTel 导入
- [ ] 添加环境变量控制
- [ ] 测试启动时间

### Step 2: 服务并行启动
- [ ] 修改 `service-manager.js` startAll()
- [ ] API 改为轮询 Redis 连接
- [ ] 添加超时和错误处理
- [ ] 测试竞态条件

### Step 3: Zod 条件验证
- [ ] 创建 `lazy-validation.ts`
- [ ] 识别启动关键路径的验证点
- [ ] 替换为条件验证
- [ ] 添加开发模式保护

### Step 4: 构建和测试
- [ ] 重新构建 API: `pnpm --filter @cat-cafe/api build`
- [ ] 重新打包桌面应用
- [ ] 生成新的安装器
- [ ] 干净环境测试

## 验证标准

### 性能目标
- 首装: < 60s（当前 117s，减少 48%）
- 冷启动: < 70s（当前 112s，减少 37%）
- 模块加载: < 35s（当前 60.7s，减少 42%）

### 功能回归
- [ ] 所有智能体正常工作
- [ ] 插件系统正常
- [ ] 浏览器集成正常
- [ ] 遥测可选启用

### 测试矩阵
| 场景 | 验证项 |
|------|--------|
| 首次安装 | 解压时间、文件数、首启时间 |
| 冷启动 | 模块加载时间、API ready 时间 |
| 热启动 | 无回归（< 5s） |
| OTel 启用 | 遥测数据正常收集 |
| OTel 禁用 | 启动加速，无遥测 |

## 风险缓解

### 风险1: 条件验证导致运行时错误
**缓解**: 
- 保留关键安全验证
- 添加运行时断言
- 完整的回归测试

### 风险2: 并行启动竞态条件
**缓解**:
- Redis 连接轮询 + 超时
- API 启动失败回退到串行
- 详细的启动日志

### 风险3: 延迟加载破坏功能
**缓解**:
- 已有 lazy-* 模式验证
- 仅延迟非关键路径
- 保留同步加载选项

## 监控指标

### 新增启动指标
```javascript
// startup-timing.js
const metrics = {
  'module-graph-load': 0,
  'module-read': 0,
  'module-parse': 0,
  'redis-ready': 0,
  'api-listening': 0,
  'services-parallel-wait': 0,
  'otel-init': 0, // 条件性
};
```

### 日志增强
```javascript
log(`[startup] Module graph: ${moduleGraphMs}ms (${moduleCount} modules)`);
log(`[startup] Services: parallel=${parallelMs}ms, total=${totalMs}ms`);
log(`[startup] OTel: ${otelEnabled ? 'enabled' : 'disabled'}`);
```

## 下一步（用户行动）

1. **立即**: 审阅本计划，确认优先级
2. **我实施**: Phase 1 的三个优化
3. **构建**: 生成新的测试 exe
4. **用户测试**: 干净环境安装和启动测试
5. **收集数据**: 实际性能数据
6. **迭代**: 根据数据调整 Phase 2 优先级

## 参考

- 性能分析: `performance-analysis-cold-start-2026-10-15.md`
- 现有证据: `issue1466-windows-clean-install-evidence-2026-10-15.md`
- 启动时序: `desktop/startup-timing.js`
- 服务管理: `desktop/service-manager.js`
