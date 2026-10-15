---
feature_ids: [F143, F161]
topics: [acp, tool-results, permission, evidence]
doc_kind: report
created: 2026-10-14
---

# 首批公开 PR 的复验边界

本报告冻结首批rebase/复验范围。2026-10-14后续提交补齐原型恢复/边界/升级证据，W4.P/W5.P分别独立Go，见[当前门禁回执](prototype-gates.md)；首批的历史held不代表当前阶段状态。HEAD `38e9f7d5d` 的16项非跳过远端CI检查全部成功，新提交另验，不能继承旧HEAD的CI结论。

首批交付关联 #1590，保持 draft，不关闭 issue，不开启迁移。范围是 print/官方 SDK 的 Claude 工具结果修复、W2.S 权限安全下限、统一方案与隔离原型；完整 Gate 仍按 [执行回执](execution-evidence.md) 独立验收。

公开基线为 upstream/main `449134fed1b08e5cf2a05a72817b84f163baf180`。将本工作线的六个提交重放到该基线，排除原起点的无关账号编辑修复；本地旧线保留在 `backup/acp-1590-before-public-rebase-20261014`。此前真实模型捕获的版本/hash 不变，是历史原型证据，不能写成在新 HEAD 重跑的真实模型验收。

rebase 保留新 main 的 canonical 工具事件 ID 和 executionRef：事件 ID 出生一次，live/socket 与持久历史共享；子调用 parent/status 沿既有身份投影。独立审查发现历史测试将函数直接传给 map 后，数组下标误作新增 executionRef 参数；两个真实捕获检查先 RED，修正为显式 invocation 后 GREEN。自动合并的两处重复 toolUseId 类型字段也经正式 tsc 的精准 RED→GREEN 修正。

## 在当前分支重新执行的检查

| 检查 | 结果 | 范围 |
|---|---|---|
| API build | exit 0 | 新 main 所需锁定依赖补齐；Git Bash 脚本；F299 14 implementers |
| 正式 Web tsc | exit 0 | packages/web/tsconfig.json 未修改；包含产品源码和测试/config |
| 源码检查 | 46/46 | decoder、持久冷读、canonical tool instance、权限策略与取消 |
| 已构建入口回归 | 92/92 | ACP STDIO/HTTP wire、工具日志、并行结果归并 |
| Web 回归 | 19/19 | 原生结果重放、canonical instance、story adapter |
| 浏览器重放 | 2/2 | CLI/SDK 捕获分别写盘、冷读、生产重放组件展开与刷新 |

日志 SHA256 和执行命令见 [机器回执](evidence/public-pr-validation.json)。浏览器使用隔离测试 origin/网络夹具，并未验收生产 API/socket 全链，也未使用完整产品样式。真实模型测试仍只含授权的受限只读合成哨兵，原始私有日志与认证不提交。

临时源码检查配置曾覆盖主配置的 worker 排除项，导致 DOM/Worker 全局类型污染；修正临时检查配置后通过，未修改产品测试来绕过错误。以前的完整 Web reporter 类型冲突在冻结锁文件依赖重新安装后不再出现，正式配置本轮通过。更宽 print/SDK 的六个历史 Windows 用例失败仍单独待处理，不能以本表覆盖。

独立审查 `/root/acp_plan_review` 复核身份合同、API 兼容和重复字段修正，无未结 P1/P2。同行为独立个体、同模型家族；回执只覆盖首批变更与 rebase，不放行完整 G0/G1、W4.P/W5.P 或整体迁移。公开最终 diff 中 Web hook 仅 9 行增加/4 行删除，没有整文件换行噪声。

下一批优先打通 W4.P 的丢回执/重连对账与 W5.P 的 elicitation、多 notice、排队取消和版本兼容，逐项保留 RED→GREEN、真实原生证据与独立审查。unknown 结果不盲目重发，原 exact/freshness 服务继续承担现有能力。
