---
doc_kind: report
feature_ids: [F311]
topics: [football, approach, time-extension, public-experiment]
created: 2026-09-07
status: observed-both-side-balls-approached-and-kicked
---

# v3 时间补充：左右偏侧远球均走近、停稳并实际触球

预声明源码 `bb93565b1f735b085f1bf9e94170bf35f2ede98c`，启动时 clean。计划 只把原 v3 未完成的两个偏侧球场景延长到 26 秒；控制器、模型、物理、球位与 reset 不变。没有把 [原 20 秒未完成结果](../20260907-approach-v3/README.md) 改判为通过。

| 场景 | 停稳阶段开始 s | kick 触发 s | 首次触球 s | kick 前接触记录 | 26 秒内跌倒 |
|---|---:|---:|---:|---:|---|
| [左偏远球录像](approach-left-far.mp4) | 21.62 | 22.24 | 22.35 | 0 | 无 |
| [右偏远球录像](approach-right-far.mp4) | 20.64 | 21.26 | 21.365 | 0 | 无 |

两份 capture 的前 1,001 条状态（0–20 秒）逐条等于原 v3 对应 capture。每份共 1,301 条，合计 2,602 条；起步、绕行、对齐过程没有挑选重跑或改变参数。本次新增观察是动作链在稍长时间内完成：左侧约需 22.35 秒，右侧约需 21.365 秒才触球。两项都由真实位置反馈进入停稳，随后只触发一次 kick；触发器没有搬动球。

球在目标 +X 方向的净位移分别为 1.9369 / 1.9127 m，侧向位移 +0.6092 / −0.1066 m。当前场景没有滚动摩擦，不能用最终距离比较优劣，也不能把 +X 位移解释成球门命中。这里证明的边界是这两个公开场景中，固定现成模型在仿真真值定位和弧线控制下能接近并踢球；不是视觉找球、泛化成功率、连续控球、独立验证或正式采用。

index.json SHA-256 `0d3cb25d72409d5d530b7ac1d838019756cb8e8e0d9ad40975428d5fb595c512`，包含完整两场景表、codeFiles/model/scene hashes 与 capture 双 hash。archive-manifest.json 保护原件。两段录像均为同轮 MuJoCo 真渲染，640×480、10 fps、261 帧、26.1 秒（含 reset 帧）；固定镜头在绕行时可能让鸭鸭短暂出画，完整状态轨迹保留。
