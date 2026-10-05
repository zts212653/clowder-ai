# Vision Evidence Workflow (B1)

> 用途：把“前端功能看起来对了”变成可审计证据。

## 第 0 步（先判适用，再谈证据包）

**本改动有视觉面吗？**没有（后端 bug / API / 纯逻辑）→ **本 workflow 不适用**，证据 = 命令输出 / 测试结果；**任何 verdict 不得以「缺视觉证物」BLOCK 无视觉面的改动**（2026-07-15 活体误杀修订：后端 bug 被要求截图——豁免原本就写在本文件，但藏在注释里不在判定路径上，故升格为第 0 步）。有视觉面 → 继续下方证据包。

## 按判断问题选择证据（仅视觉面改动）

先用已接受的参考与本次实际页面判断操作和结果是否一致。截图适合空间关系，操作记录或短录屏适合状态变化，保存与恢复还需要相应真实数据证据。选最少但足够判断的材料，不规定截图/录屏数量或必须填映射表；已有证据适用时直接引用。下面的采集步骤和表格只是可选方法。

## 工具建议（已有 MCP）

- Claude in Chrome：用浏览器截图/录屏工具
- Codex 浏览器：`browser_navigate` + `browser_take_screenshot`

## 默认落点

- 临时截图 / 录屏默认存 `${TMPDIR}/cat-cafe-evidence/{branch-or-feature}/{date}/`
- 截图/导出命令必须显式设置输出文件名（`filename` / `path`）；禁止依赖工具默认输出到当前目录
- 需要入库的证据，再显式 copy 到 `project-evidence/` 或文档自带 `assets/` 目录
- 不要把媒体工件或 `.pen` 设计文件直接留在仓库根目录（见 `refs/evidence-output-contract.md`）

## 可选采集方式

1. 明确这次验收的需求点（来自 discussion/spec）。
2. **Runtime Guard（若在 `cat-cafe-runtime`）**：
   - 先探活：`curl -sf http://localhost:3004/health`
   - 服务在线就直接复用，禁止为截图执行 `pnpm start` / `pnpm runtime:start` / `pnpm runtime:restart` / `pnpm runtime:stop` / `./scripts/start-dev.sh`
   - 确实要重启时，先拿到operator明确授权，再执行 `pnpm runtime:restart`；不要把 shell 开关当授权凭据
3. 进入目标页面，覆盖关键状态（初始态 / 成功态 / 错误态）。
4. 按判断需要截画面或记录关键操作，长度以能看清相关行为为准；临时文件默认写到 `${TMPDIR}/cat-cafe-evidence/...`，且每次工具调用都显式给出输出路径。
5. 需要入库时，再显式归档到 `project-evidence/` 或对应 `assets/` 目录。
6. 在现有 quality-gate / review 请求中说明需求、观察与结论的关系；短文或下方表格均可。

### 输出路径示例（推荐）

```bash
OUT_DIR="${TMPDIR}/cat-cafe-evidence/${BRANCH_OR_FEATURE}/$(date +%F)"
mkdir -p "$OUT_DIR"
# browser_take_screenshot / browser_screenshot 等工具都传入 "$OUT_DIR/xxx.png"
```

## 可选的需求→证据映射模板

```markdown
| # | 需求点 | 证据 | 结论 |
|---|--------|------|------|
| 1 | “用户能看到任务领取状态” | screenshot-1.png | ✅ |
| 2 | “领取失败有明确提示” | screenshot-2.png | ✅ |
| 3 | “切换任务时状态不闪烁” | recording-1.mp4 (00:04-00:10) | ✅ |
```

## 常见错误

- 只贴截图，不说明它支持哪项判断。
- 录屏太长，关键行为难定位。
- 把后端任务也强行要求截图（不需要）。
- 为了截图在 runtime 会话里重启服务，导致在线实例中断。
- 临时截图直接掉在仓库根目录。
- 截图/录屏命令没写输出路径，导致文件默认落在 cwd。
