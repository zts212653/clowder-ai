# PR #1519 提交审查报告

## 审查日期
2026-10-16

## 审查范围
- 分支：`feat/onboarding-first-run`
- 基于：`origin/main`
- 审查重点：今天新增的性能优化相关提交（5711c0fe4 ~ a1d28aae0）

---

## 审查结果总结

### ✅ 整体评估：基本合理，已自行清理

今天新增了 5 次性能相关提交，最后一次提交 `a71072023` 已经主动清理了未集成的实验性代码。

### 📊 提交清单

#### 今天的性能优化提交（按时间顺序）

1. **5711c0fe4** - `perf(startup): add performance analysis and optimization infrastructure`
   - ✅ 性能分析文档（合理）
   - ✅ lazy-telemetry.ts（实验性工具）
   - ✅ lazy-validation.ts（实验性工具）

2. **f88b9474a** - `perf(desktop): enable ASAR and document root cause of slow startup`
   - ✅ 启用 ASAR（desktop/package.json）
   - ✅ 根本原因分析文档
   - ✅ artifacts/ 中的测试报告

3. **65a13a319** - `perf(desktop): add ASAR optimization analysis and realistic implementation path`
   - ✅ pre-bundle-packages.mjs（实验性脚本）
   - ✅ 现实评估文档
   - ✅ pnpm-lock.yaml（添加 @electron/asar 依赖）

4. **a1d28aae0** - `docs: create upstream issue #1606 for installation and startup performance`
   - ✅ 上游 issue 文档

5. **a71072023** - `fix(ci): remove unintegrated startup prototypes and format helpers`
   - ✅ **主动清理**：删除了未集成的 lazy-telemetry.ts 和 lazy-validation.ts
   - ✅ 保留了文档中的引用说明

---

## 详细问题分析

### ⚠️ 问题 1：实验性工具文件（已清理）

**问题**：
- `packages/api/src/telemetry/lazy-telemetry.ts`
- `packages/api/src/config/lazy-validation.ts`

这两个文件创建后未集成到实际代码中，属于实验性原型。

**状态**：✅ **已在 a71072023 中删除**

**判断**：正确。未集成的工具不应该提交到产品代码中。

---

### ⚠️ 问题 2：实验性打包脚本

**文件**：`desktop/scripts/pre-bundle-packages.mjs`

**分析**：
- 创建于 65a13a319
- 用途：预打包 packages 到 ASAR
- 问题：实测耗时 >180 秒，不可行
- 状态：❌ **仍在代码库中**

**判断**：
- 如果配套的文档说明了"实验性，不推荐"，可以保留作为参考
- 但更好的做法是移到 `artifacts/` 或删除

**建议**：
```bash
# 选项 A：移到 artifacts
git mv desktop/scripts/pre-bundle-packages.mjs artifacts/experiments/

# 选项 B：删除（因为文档中已经说明不可行）
git rm desktop/scripts/pre-bundle-packages.mjs
```

---

### ⚠️ 问题 3：artifacts/ 目录内容

**当前状态**：
```
artifacts/
├── performance-optimization-report.md  ✅ 合理（总结报告）
├── issue1466-zero-start-20261013/     ✅ 合理（测试证据）
├── ci-a1d28aae0/                       ⚠️ 未提交（untracked）
├── install-perf-*.log                  ⚠️ 多个日志文件
└── built-web-assets-red.log            ⚠️ 日志文件
```

**分析**：
- `performance-optimization-report.md`：✅ 有价值的总结文档
- `issue1466-zero-start-20261013/`：✅ 测试证据
- `ci-a1d28aae0/`：❌ 未提交，本地 CI 调试产物
- `*.log` 文件：⚠️ 如果是一次性调试日志，应该清理

**.gitignore 覆盖**：
- `artifacts/` 不在 `.gitignore` 中
- 这意味着 artifacts 内容是**有意提交**的

**判断**：
- 如果 `*.log` 是性能测试的证据，保留合理
- 如果是调试过程产物，应该清理

**建议**：
```bash
# 清理未提交的 CI 产物
rm -rf artifacts/ci-a1d28aae0/

# 审查并清理不必要的日志
ls -lh artifacts/*.log  # 检查大小和内容
# 如果是调试日志，删除
```

---

### ✅ 问题 4：文档完整性

**已提交的文档**：
- ✅ `docs/design/performance-analysis-cold-start-2026-10-15.md` - 完整分析
- ✅ `docs/design/asar-optimization-root-cause.md` - 根本原因
- ✅ `docs/design/asar-implementation-strategy.md` - 实施方案
- ✅ `docs/design/asar-implementation-reality-check.md` - 现实评估
- ✅ `docs/design/startup-optimization-implementation-plan.md` - 实施计划
- ✅ `docs/design/startup-optimization-summary.md` - 总结
- ✅ `docs/issues/upstream-performance-issue.md` - 上游 issue

**判断**：✅ 文档齐全，适合提交

---

### ✅ 问题 5：实际生产代码修改

**唯一的产品代码修改**：
```json
// desktop/package.json
{
  "build": {
    "asar": true,  // false → true
    "asarUnpack": [  // 新增
      "**/*.node",
      "**/node_modules/@anthropic-ai/claude-agent-sdk-*/claude-agent-sdk.*.node"
    ]
  }
}
```

**判断**：✅ 合理且已验证通过

---

### ⚠️ 问题 6：本地构建产物

**未提交但存在于 worktree**：
- `desktop/dist/` - 2.1GB
- `desktop-dist/` - 未知大小
- `dist/` - 未知大小
- `bundled/` - 未知大小

**状态**：✅ 已在 `.gitignore` 中，不会被提交

**判断**：✅ 正确处理

**建议**：定期清理以节省磁盘空间
```bash
rm -rf desktop/dist desktop-dist dist bundled
```

---

## 建议的清理操作

### 必须清理（影响 PR 质量）

#### 1. 删除实验性打包脚本
```bash
git rm desktop/scripts/pre-bundle-packages.mjs
git commit -m "cleanup: remove experimental pre-bundle script (not integrated, >180s runtime)"
```

**理由**：
- 实测不可行（>180秒）
- 未集成到构建流程
- 文档中已说明不推荐
- 保留会误导后续开发者

#### 2. 更新依赖（可选）
```bash
cd desktop
pnpm remove @electron/asar
cd ..
git add desktop/package.json desktop/package-lock.json
git commit -m "cleanup: remove unused @electron/asar dependency"
```

**理由**：
- pre-bundle 脚本已删除
- 不再需要这个依赖

### 推荐清理（本地 worktree）

#### 3. 清理本地构建产物
```bash
rm -rf desktop/dist desktop-dist dist bundled
rm -rf artifacts/ci-a1d28aae0/
```

**理由**：节省磁盘空间（~2-3GB）

#### 4. 清理日志文件（如果不需要）
```bash
# 先检查
ls -lh artifacts/*.log

# 如果是调试日志，删除
rm artifacts/built-web-assets-red.log
rm artifacts/install-perf-*.log
```

---

## PR #1519 的最终状态评估

### ✅ 优点

1. **自我纠正**：a71072023 主动清理了未集成代码
2. **文档完整**：7 个详细的分析和实施文档
3. **实际改动小**：仅修改 desktop/package.json（启用 ASAR）
4. **问题已上报**：创建了 issue #1606 到上游

## 后续状态（2026-10-16）

本文前面的清理建议已由提交 `0977dac` 完成：实验脚本 `desktop/scripts/pre-bundle-packages.mjs` 已删除，`@electron/asar` 依赖也已移除。不要重复执行历史方案中的删除命令或清理其他实例产物。

本次验收基线为 PR HEAD `eaa47bf`、base `466d454`。该 HEAD 的 CI 有两项根因失败：Biome 格式检查拒绝 `desktop/subprocess-entry.js` 的条件表达式换行；Public contract surfaces 在 Linux 上因测试夹具使用 `path.join('C:', ...)`，把相对路径误当成 Windows 盘符路径。`Test (Public)` 是 contract 失败的下游门禁，不是第三个独立测试根因。当前提交状态与重新运行后的 CI 结果应以 PR Checks 页面为准。

`upstream/main` 已包含在该基线历史中。完整 Inno Setup 首装、当前 HEAD 的首次启动和既有数据保留仍需按本方案独立验收；CI 通过或 ASAR 内容检查不能替代真实安装器验证，也不能单独作为 PR 可合并结论。
