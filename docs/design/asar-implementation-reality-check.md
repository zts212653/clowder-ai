---
feature_ids: [F155, F229, F320]
topics: [performance, desktop, packaging]
doc_kind: design
created: 2026-10-15
---

# ASAR 实验复盘（历史记录）

> 2026-10-16 状态更正：预打包脚本未接入构建，已连同新增的直接依赖删除；下文候选代码不作为当前实施步骤。
> electron-builder 自身的传递依赖仍由桌面 npm 锁文件管理；现有 ASAR 配置和独立服务入口保持原状。
> 前一轮未接入的遥测/校验原型也已撤出；性能收益必须通过 #1606 的实际首装/首启验证，不能据文件数或一次超时推算。

历史实验记录为预打包运行超过180秒、未完成；仅凭该记录，不能确定是体积、文件数或其它等待导致。

## 更实际的方案：修改 electron-builder 配置

### 核心思路
不预先创建 packages.asar，而是让 electron-builder 在构建时将所有内容打包到 app.asar 中。

### 修改 desktop/package.json

```json
{
  "build": {
    "asar": true,
    "asarUnpack": [
      "**/*.node",
      "**/node_modules/@anthropic-ai/claude-agent-sdk-*/claude-agent-sdk.*.node"
    ],
    "files": [
      // 主进程代码
      "*.js",
      "*.html",
      "assets/**/*",
      "plugin-window/**/*",
      "!**/*.test.*",
      
      // ✅ 关键改动：将 extraResources 的内容移到这里
      "../bundled/deploy/**/*",
      "../cat-template.json",
      "../pnpm-workspace.yaml", 
      "../package.json",
      "../cat-cafe-skills/**/*",
      "../.claude/hooks/**/*",
      "../docs/**/*",
      "../scripts/**/*",
      "../guides/**/*",
      "../assets/**/*",
      "../packages/api/src/plugins/**/*"
    ],
    "extraResources": [
      // ❌ 删除 packages 相关的配置
      // ✅ 仅保留绝对必须在外部的二进制（Windows 上为空，因为 node/redis 由安装脚本处理）
    ]
  }
}
```

### 代码调整

需要修改 `project-root.js` 和 `service-manager.js` 中的路径解析：

```javascript
// 当前：packages 在 resources/ 下
const apiEntry = path.join(this.root, 'packages', 'api', 'dist', 'index.js');

// 修改后：packages 在 app.asar 中
const isAsar = __dirname.includes('.asar');
const apiEntry = isAsar 
  ? path.join(process.resourcesPath, 'app.asar', 'bundled', 'deploy', 'api', 'dist', 'index.js')
  : path.join(this.root, 'packages', 'api', 'dist', 'index.js');
```

### 风险评估

**问题**：Node.js 能否 spawn ASAR 中的脚本？

测试结果：
- ✅ `require()` 可以加载 ASAR 中的模块
- ❌ `spawn('node', ['script.js'])` 不能直接执行 ASAR 中的脚本

**解决方案 A**：提取到临时目录
```javascript
const tmp = require('os').tmpdir();
const extractedApi = path.join(tmp, 'clowder-api-runtime');
fs.cpSync(asarPath, extractedApi, { recursive: true });
spawn('node', [path.join(extractedApi, 'index.js')]);
```

**解决方案 B**：使用 Node.js API 而非 spawn
```javascript
// 不用 spawn，直接在主进程中 require 并启动
const apiMain = require(path.join(asarPath, 'api/dist/index.js'));
```

**解决方案 C**：放弃完全 ASAR，使用压缩优化（方案 C）

## 建议：回到方案 C（优化压缩）

鉴于：
1. 预打包耗时过长（>180秒）
2. Node.js spawn 不支持 ASAR 中的脚本
3. 提取到临时目录会抵消性能收益

**推荐更务实的方案 C**：

### 1. 优化归档压缩
```javascript
// desktop/scripts/create-runtime-archive.mjs
await tar.c({ 
  file, 
  cwd: source, 
  portable: true, 
  zstd: true,  // 使用 zstd 替代 gzip（更快）
  jobs: os.cpus().length,  // 多线程
  follow: false 
}, ['.']);
```

### 2. 优化安装器解压
在 Inno Setup 中使用并行解压和更快的算法

### 3. 减少文件数
- Bundle 更多依赖（OpenTelemetry、小型纯JS库）
- 移除未使用的文件（tests、docs）

### 4. 首次启动优化
- 评估可选模块的延迟加载，同时保留统一遥测入口和配置校验
- 预热缓存
- 提示用户添加 Windows Defender 排除

## 预期效果（方案 C）

- 安装时间：117s → **60-80s**（减少 32-49%）
- 冷启动：112s → **70-85s**（减少 24-37%）
- 实施风险：低
- 实施时间：1-2 小时

这是更稳健、可验证的方案。
