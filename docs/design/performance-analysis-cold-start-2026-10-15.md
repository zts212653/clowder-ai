---
feature_ids: [F155, F229, F320]
topics: [performance, startup, installation, optimization]
doc_kind: analysis
created: 2026-10-15
---

# 安装与冷启动性能分析与优化方案

## 当前性能基线（PR#1519）

### 测量数据
| 阶段 | 当前耗时 | 占比 |
|------|---------|------|
| 安装解压 | 117.4s | 100% |
| 首次启动 | 112.2s | 100% |
| 模块图加载 | 60.7s | 54% |
| - 模块读取 | 50.9s | 45% |
| - 模块解析 | 5.7s | 5% |
| API进程监听 | 73.9s | 66% |

### 归档分布
| 归档 | 条目数 | 校验ms | 解压ms | 总计 |
|------|--------|--------|--------|------|
| 公共依赖 | 68,629 | 5,248 | 56,213 | 61.5s |
| API | 11,484 | 533 | 3,583 | 4.1s |
| Web | 1,312 | 791 | 924 | 1.7s |
| MCP | 1,366 | 67 | 473 | 0.5s |
| Electron | 128 | 1,317 | 949 | 2.3s |
| **总计** | **82,919** | **7,956** | **62,142** | **70.1s** |

### 关键瓶颈识别

1. **模块加载瓶颈（60.7s，54%）**
   - 3,275次模块加载
   - 包含大量外部依赖：undici、puppeteer、ajv、zod、插件等
   - 模块读取占主要时间（50.9s）

2. **归档解压瓶颈（70.1s，60%）**
   - 82,919个文件条目
   - 公共依赖占68,629个条目（83%）
   - gzip level 1，已是最快压缩

3. **依赖树膨胀**
   - API包含11,484个文件
   - 许多依赖在启动时并不需要

## 性能目标

参考业界标准（如 VS Code、Claude Desktop），设定目标：
- 首次安装：< 30s（减少 75%）
- 冷启动：< 10s（减少 91%）
- 热启动：< 3s

## 优化方案

### Phase 1: 启动路径优化（预期收益：50-60s）

#### 1.1 延迟加载非核心模块
**问题**：3,275次模块加载中，许多在启动阶段不需要

**方案**：
- puppeteer：仅在首次使用 F247 Chrome 功能时加载
- 插件系统：延迟到用户实际使用插件时
- 遥测模块：异步初始化，不阻塞启动
- ajv/zod 验证：开发模式严格验证，生产环境简化

```typescript
// 当前：启动时同步加载
import { launch } from 'puppeteer';

// 优化：延迟加载
const launchBrowser = async () => {
  const { launch } = await import('puppeteer');
  return launch();
};
```

**实施**：
- [ ] 审计 `packages/api/src/index.ts` 启动依赖
- [ ] 识别首屏不需要的模块（puppeteer、插件、高级功能）
- [ ] 改为动态 import() + 模块缓存
- [ ] 测试验证功能完整性

**预期收益**：减少 30-40s 模块加载时间

#### 1.2 API Bundle 分包
**问题**：单一 bundle 包含所有代码，启动时加载全部

**方案**：
- Core bundle：启动必需（路由、基础服务、认证）
- Feature bundles：按功能分包（插件、浏览器集成、高级功能）
- Lazy chunks：运行时动态加载

```javascript
// desktop/scripts/bundle-desktop-api.mjs
const bundles = {
  core: ['index.js', 'routes/*.js', 'domains/auth/**'],
  plugins: ['plugins/**'],
  browser: ['domains/personal-chrome/**'],
  telemetry: ['domains/telemetry/**']
};
```

**实施**：
- [ ] 分析启动调用链，确定 core 边界
- [ ] 修改 esbuild 配置，生成多个 chunk
- [ ] 更新 service-manager.js 加载逻辑
- [ ] 验证功能隔离性

**预期收益**：减少 15-20s 初始加载时间

### Phase 2: 安装包优化（预期收益：40-50s）

#### 2.1 依赖树剪枝
**问题**：82,919个文件，公共依赖占83%

**方案**：
- 移除开发依赖（@types、测试工具）
- 使用 `esbuild` bundle 常用纯JS库（yaml、toml、xml-parser）
- 替换重量级依赖：
  - `ajv` → 简化验证或运行时跳过
  - `zod` → 仅开发环境使用
  - `undici` → 使用 Node.js 内置 `fetch`

**实施**：
- [ ] 生成依赖树报告：`pnpm list --depth=99 > deps.txt`
- [ ] 识别可移除/替换的依赖
- [ ] 更新 `bundle-desktop-api.mjs` 的 `bundledDependencies`
- [ ] 重新生成 frozen lock 和归档

**预期收益**：减少 30,000+ 文件，节省 30-40s 解压时间

#### 2.2 增量安装/更新
**问题**：每次都解压全部82,919个文件

**方案**：
- 差量更新：仅下载变更的文件
- 内容寻址：通过 hash 复用已有文件
- 流式解压：边下载边解压，不等待完整包

```typescript
// 更新逻辑
const delta = computeDelta(currentVersion, newVersion);
await downloadDelta(delta); // 仅下载变更
await applyDelta(delta);    // 仅解压变更
```

**实施**：
- [ ] 设计 manifest 格式（文件路径 + hash）
- [ ] 实现差量计算和应用
- [ ] 更新 update-installer.js
- [ ] 测试升级场景

**预期收益**：升级时减少 80%+ 时间

#### 2.3 预编译 + AOT
**问题**：首次运行需要解析和 JIT 编译

**方案**：
- 使用 V8 snapshot/bytecode cache
- 预生成 ESM 依赖的解析缓存
- 考虑 Bun/Deno 的更快启动

**实施**（探索性）：
- [ ] 研究 Node.js V8 snapshot 支持
- [ ] 测试 esbuild bundle 对解析的影响
- [ ] 评估迁移到 Bun 的可行性

**预期收益**：减少 5-10s 解析时间

### Phase 3: 架构优化（预期收益：10-20s）

#### 3.1 服务启动并行化
**问题**：Redis → API → Web 串行启动

**方案**：
```javascript
// 当前：串行
await startRedis();
await startAPI();
await startWeb();

// 优化：并行
await Promise.all([
  startRedis(),
  startAPI({ waitForRedis: false }), // API 自行等待 Redis ready
  prebuildWebAssets()  // Web 资源预热
]);
```

**实施**：
- [ ] 修改 service-manager.js startAll()
- [ ] API 改为轮询 Redis 连接（带超时）
- [ ] 测试竞态条件

**预期收益**：减少 5-10s 串行等待

#### 3.2 首屏渲染优化
**问题**：等待所有服务启动才显示界面

**方案**：
- 立即显示主窗口（骨架屏）
- 服务启动状态实时反馈
- 后台异步完成初始化

**实施**：
- [ ] 修改 main.js，先显示窗口
- [ ] 添加启动进度条组件
- [ ] API 提供 /health/startup 端点

**预期收益**：感知启动时间减少 50%

### Phase 4: 平台特定优化

#### 4.1 Windows Defender 排除
**问题**：实时扫描影响文件读取

**方案**：
- 安装时提示用户添加排除路径
- 文档说明性能影响

#### 4.2 磁盘IO优化
- 使用固态硬盘检测
- 调整文件缓冲策略
- 监控磁盘队列深度

## 实施计划

### Sprint 1（1周）：快速收益
- [x] 性能基线测量和分析（本文档）
- [ ] Phase 1.1：延迟加载 puppeteer 和插件
- [ ] Phase 3.1：服务并行启动
- [ ] 测试验证：预期从 112s → 70s

### Sprint 2（1周）：依赖优化
- [ ] Phase 2.1：依赖树剪枝（前50%）
- [ ] Phase 1.2：API 分包（core + features）
- [ ] 测试验证：预期从 70s → 40s

### Sprint 3（1周）：深度优化
- [ ] Phase 2.1：依赖树剪枝（后50%）
- [ ] Phase 3.2：首屏渲染优化
- [ ] Phase 2.2：增量安装设计
- [ ] 测试验证：预期从 40s → 20s

### Sprint 4（1周）：最后一公里
- [ ] Phase 2.2：增量安装实现
- [ ] Phase 2.3：预编译探索
- [ ] 全平台验证（Windows/macOS）
- [ ] 目标达成：< 10s 冷启动

## 监控和验证

### 性能测试矩阵
| 场景 | 当前 | 目标 | 验证方法 |
|------|------|------|----------|
| 首次安装（全新机器） | 117s | 30s | 虚拟机冷测试 |
| 冷启动（重启后） | 112s | 10s | 清空系统缓存后测试 |
| 热启动（已运行过） | 4.5s | 3s | 连续启动测试 |
| 升级安装 | 117s | 15s | 差量更新测试 |

### 回归测试
- [ ] 所有功能完整性测试
- [ ] 插件系统延迟加载验证
- [ ] 浏览器集成功能验证
- [ ] 跨平台一致性测试

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 延迟加载破坏功能 | 高 | 完整回归测试 + 用户可配置 |
| 依赖剪枝遗漏运行时依赖 | 高 | 冒烟测试 + 生产验证 |
| 并行启动竞态条件 | 中 | 完善错误处理 + 重试机制 |
| 增量更新兼容性 | 中 | 保留完整安装降级路径 |

## 参考与对比

### VS Code
- 安装：< 20s（70MB，预编译）
- 冷启动：< 3s（Electron + 延迟扩展）
- 热启动：< 1s

### Claude Desktop（推测）
- 小型依赖树（无 puppeteer 等重型库）
- 单一功能焦点（对话界面）
- 可能使用 native 模块而非 Node.js 生态

### 我们的特点
- 多智能体编排（更复杂）
- 浏览器集成（puppeteer 是硬需求）
- 插件生态（需要隔离加载）

**结论**：通过上述优化，10s 冷启动是可实现的目标。

## 下一步行动

1. **立即执行**（本次会话）：
   - 实施 Phase 1.1：识别并延迟加载 puppeteer
   - 实施 Phase 3.1：服务并行启动
   - 生成依赖树报告

2. **用户验证**（需用户参与）：
   - 提供优化后的测试版 exe
   - 干净环境安装测试
   - 收集实际性能数据

3. **持续优化**（后续迭代）：
   - 根据实测数据调整优先级
   - 逐步完成 Phase 2-4
   - 建立性能回归监控
