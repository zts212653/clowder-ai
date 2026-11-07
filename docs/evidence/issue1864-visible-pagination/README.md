---
feature_ids: [F232, F307]
topics: [works, pagination, issue-1864]
doc_kind: evidence
created: 2026-11-07
---

# Issue #1864 可见 Works 分页验证

依据：[维护者已确认的交互与边界](https://github.com/zts212653/clowder-ai/issues/1864#issuecomment-6700648617)。实施基线为重新拉取并核对的 `upstream/next@3569a9b6422723faf3a586b68232c140f84b44a1`。

## 行为与请求计数

Chrome 打开实际 `NewConversationPage` 与 `F307ExperienceWorkbench`，作品请求进入真实 Fastify `threadsRoutes`。用户、消息、Task 均为隔离夹具；lineage 解析器是替身，socket 来源变化在前端事件边界注入。没有连接生产数据或重启 runtime。该验证证明本片组件、reader 和实际路由的组合行为，不替代完整运行时的登录与真实用户数据验收。

常规目录含 400 条消息、272 件作品，各页为 128、0、128、16 件。稀疏目录含 1,100 条消息，前八页为零件，第九页有 16 件。

| 动作 | 修改前 | 修改后 |
| --- | --- | --- |
| 可见全局 Works 首开 | 自动 4 次分页 GET | 1 次；先渲染 24 张卡 |
| 滚动展开已读卡片 | 新增 0 次 GET | 新增 0 次 GET |
| 常规目录主动继续 | 没有独立的服务端续读动作 | 首次继续读 2 页，在新增 128 件后停；再次继续 1 页到末页，整页保留 |
| 稀疏目录 | 自动读到第九页 | `1+4+4`；第 1、5 页后仍有继续入口，第 9 页显示共 16 件 |
| 首页首开 | 近期 GET 1 次，12 件 | 相同 |
| 首页底部动作 | 首页另起 4 页全量 reader，预览变为 24 件，没有打开目录 | 打开现有全局 Works，分页 GET 1 次；预览保持 12 件 |
| 底部操作后再点顶部「全部作品」 | 又读 4 页 | 进入同一全局目录，新增 0 次 GET |
| 普通文本/Task 投影活动 | 文本 0 次；Task 冷却后重扫 4 页，首页另读近期 1 次 | 列表/cursor 不变，新增 0 次 GET |
| 确认发布一件作品 | 全局重扫 4 页；首页另读近期 1 次和全局 4 页 | 全局提示更新、分页 GET 0；首页把两条同次发布信号合并为近期 GET 1 次 |
| 首页预览为空或 503 | 目录入口行为不一致 | 顶部、底部都可打开全局 scope，仍只读首批 1 页 |

修改前记录使用 `b58412451873ae451af8b02fd0ee8d4112ddb968` 检出；已核对它与上述最新 next 的入口、reader、路由及 Web 测试字节一致。两入口 RED 留下实际断言失败：`4 != 1`、`24 != 12`、底部未打开目录，以及顶部额外重复 4 页。

实物截图：[筛选零命中后仍可继续](works-partial.png) · [连续空批次后的继续入口](sparse-partial.png) · [首页预览与全局目录](home.png)。

## 取消、刷新、权限与部分结果

- 浏览器验证：部分集合名称筛选零命中仍可继续；第一个空批次后继续入口不消失；隐藏会取消在途请求，恢复不发 GET，并保留查询、类型、滚动和最后已提交 cursor。迟到空页不能偷偷推进 cursor。
- 503 续页失败保留已提交数据和 cursor，从同一 cursor 重试。主动刷新只读一个无 cursor 首批，成功同时替换列表/cursor；失败保留旧状态，重试刷新仍从第一页开始。
- 组件/reader 回归覆盖：部分计数、零命中的已选类型、24 件阈值不按筛选命中数计算、末页 lineage 不可用时保留作品与重试、400/409/401/403 清空旧快照、session owner 切换与迟到响应、隐藏时无坐标撤权，以及 #1873 的可见 thread sibling 继续读取。
- 广泛 Task 失效不会当作材料变化；现有广播增加可选 `reason: works_changed | access_revoked`，已有消费者仍可使用旧 payload。材料发布、保存和 LivingWork commit 标记作品变化。关联目录成功移除、thread 成功软删除发明确撤权；没有 threadId 的撤权同样清空快照并 abort/fence 迟到响应。失败或无实际移除不发撤权通知。

计数分别采集浏览器请求、真实路由开始、完成与收到的取消通知，见 [browser-counts.json](browser-counts.json)。基线两入口整套操作为 GET 31、路由开始 31、完成 31、取消通知 0。候选普通浏览阶段的每个 GET 都对应一个真实路由执行；隐藏场景浏览器与服务端各观察到一次取消通知，但已开始的处理在释放夹具闸门后仍完成。这两个计数允许重叠，不能据此宣称取消打断了服务端计算。

## 复跑与检查

安装冻结依赖并构建 shared/mcp-server 后，从 API 包运行可移植探针（需要已安装 Chrome）：

```sh
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/mcp-server build
pnpm --filter @cat-cafe/api exec node --import tsx ../web/test/browser/issue1864-visible-pagination.test.mjs
```

默认把 JSON、截图和临时 bundle 放在新的系统临时目录；可通过 `ISSUE1864_EVIDENCE_DIR` 指定证据目录。探针仅监听独立随机 loopback 端口，finally 关闭 Chrome 与 Fastify。实际入口夹具与路由夹具位于相邻 `fixtures/issue1864-*` 文件中。

作者检查：11 个相关 Web 文件共 94 项、9 项 API 路由/分页/linked-root 回归通过；Web 与 API 类型检查、受影响源文件 Next ESLint、Biome 和 `git diff --check` 通过。Biome 的旧大文件复杂度/non-null 警告保留，没有为本片重构周边代码。浏览器脚本与截图额外验证上表实际入口，不能由单测数量替代。

## 并行候选与边界

开工与提 PR 前均检查了主仓、`whutzefengxie-ops` 与 `mindfn` fork 的 Draft/Open/Merged/Closed 候选和 Issue 回复，未发现重复可见分页实现。#1873/#1866 已在基线内。fork [#252](https://github.com/mindfn/clowder-ai/pull/252) 负责线程局部替换，[#254](https://github.com/mindfn/clowder-ai/pull/254) 负责服务端续页授权；本片不复制这两份实现，不扩大页大小、缓存范围或跨页架构。

新候选 [#1906](https://github.com/zts212653/clowder-ai/pull/1906) 的 `useSocket.ts` 改动是 History 水位 import/调用，与本片作品事件的 hunk 不相交，已向对应线程对齐。[#1897](https://github.com/zts212653/clowder-ai/pull/1897) 负责图片草稿保存/取消；本片保留其职责，不修改 `NewConversationPage.tsx` 或 admission 路径。首页通过既有 `default` owner 打开 Works，其 global scope 已由浏览器确认。

## 回退与余项

可整体 revert 本片提交，不需要数据迁移或用户配置改动。回退会恢复原来的自动 drain/首页展开行为。服务端续页授权成本与已知线程的局部替换仍分别由 #254/#252 负责；本片保留现有 512 候选上限和授权规则。Issue #1864 的最终验收与关闭留给维护者按实际 PR 判断。
