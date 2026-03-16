# Bug 诊断胶囊模板（共享参考）

> 归属 skill: `debugging`
>
> 引用方: `tdd`（Bug Fix 模式入口）、`opensource-ops` Scene A（社区 bug 信息完备度评估）

## 什么时候用

- **debugging**：Phase 1 根因调查开始时，填写胶囊框架
- **tdd**：Bug Fix 模式入口，先填胶囊再写失败测试
- **opensource-ops Scene A**：评估社区 bug report 信息完备度，缺栏 = 需要向报告者追问

## 8 栏模板

```markdown
### Bug 诊断胶囊：{简述}

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 什么坏了？期望 vs 实际行为。含错误信息/截图/日志 |
| **2. 证据** | 复现步骤、环境信息、相关 commit/PR、stack trace |
| **3. 问题假设或根因** | "我认为根因是 X，因为 Y"（调查前可以是假设，调查后更新为根因） |
| **4. 诊断策略** | 打算怎么查：加诊断桩？数据流逆向追踪？对照工作代码？ |
| **5. 超时策略** | 查 N 分钟没进展怎么办？升级铲屎官？换方向？缩小范围？ |
| **6. 预警策略** | 什么信号说明方向错了？（如：3 次修复都失败 = 架构问题） |
| **7. 用户可见交互修正**（可选） | 如果 bug 影响用户体验，修复后用户侧会有什么变化？ |
| **8. 验收** | 怎么确认修好了？失败测试名、手工验证步骤、CI 检查项 |
```

## 使用说明

### 内部 bug（debugging + tdd）

1. 发现 bug → 先填 **1-6 栏**（现象到预警策略）
2. Phase 1 根因调查完成 → 更新第 3 栏为确认的根因
3. Phase 4 写失败测试 → 填第 8 栏（验收）
4. 修复后如有用户侧影响 → 填第 7 栏
5. 胶囊存放位置：`docs/bug-report/<bug-name>/bug-report.md`（与 debugging 五件套合并）

### 社区 bug（opensource-ops Scene A）

用胶囊评估社区 issue 的信息完备度：

| 栏位 | 社区 issue 中对应的信息 | 缺失时的动作 |
|------|----------------------|-------------|
| 1. 现象 | issue 描述 | 通常有，但可能模糊 → 追问具体行为 |
| 2. 证据 | 复现步骤、环境、版本 | **最常缺失** → 用 `needs-info` 标签 + 追问模板 |
| 3. 假设/根因 | 报告者的猜测（参考但不依赖） | 不需要报告者提供，maintainer 自己判断 |
| 4-6 | maintainer 内部填写 | — |
| 7 | 报告者期望的修复效果 | 有助于理解需求，但不是必填 |
| 8 | 报告者的验证方式 | 可参考，但 maintainer 定最终验收标准 |

**追问模板**（第 2 栏缺失时）：

```markdown
Thanks for reporting! To help us investigate, could you provide:

1. **Steps to reproduce** — what exactly did you do?
2. **Expected vs actual behavior** — what did you expect to happen?
3. **Environment** — OS, browser/runtime version, package version
4. **Error messages** — full error output or screenshots if available

{猫猫签名}
```

## 和 debugging 五件套的关系

| debugging 五件套 | 胶囊 8 栏 | 说明 |
|-----------------|----------|------|
| 1. 报告人 | —（元信息） | 五件套保留，胶囊不重复 |
| 2. 复现步骤 | 1. 现象 + 2. 证据 | 胶囊拆得更细 |
| 3. 根因分析 | 3. 假设/根因 + 4. 诊断策略 | 胶囊加了诊断方法论 |
| 4. 修复方案 | 7. 用户可见交互修正 | 胶囊侧重用户视角 |
| 5. 验证方式 | 8. 验收 | 等价 |
| — | 5. 超时策略 | **胶囊新增**：防止无限下钻 |
| — | 6. 预警策略 | **胶囊新增**：防止方向错误 |

**五件套是 bug report 的存档格式，胶囊是调查过程的工作模板。** 两者互补，不互相替代。
