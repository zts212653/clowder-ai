---
doc_kind: report
feature_ids: [F311]
topics: [football, arc-path, public-experiment]
created: 2026-09-07
status: observed-arc-progress-with-timeout
---

# v3：弧线保持步态，偏侧球尚未在 20 秒内完成

预声明源码 `c0052ae3925b2143e911a9db0a2d5891fe71e7c3`，启动时 clean；index.json SHA-256 `85dad733e0b1af593157b48b68330ce7d069364338e9b95d24dcc69fd35ed9a4`。原八个场景、20 秒、模型、物理与 reset 均保持不变，只将接近控制改为前进弧线路径。完整控制命令、路径进度、球/机器人状态、61 维观测和 14 维动作都在八份 capture 中。

| 场景 | kick 触发 s | 首次触球 s | 结果 |
|---|---:|---:|---|
| direct-left-far / direct-right-far | 1 / 1 | 无 / 无 | 原地踢不到远球 |
| approach-left-near / approach-right-near | 1.62 / 1.62 | 1.72 / 1.73 | 保持停稳后踢近球 |
| approach-left-straight / approach-right-straight | 4.6 / 4.6 | 4.7 / 4.705 | 已走近后触球 |
| approach-left-far / approach-right-far | 未触发 / 未触发 | 无 / 无 | 弧线已接近准备位，但超出 20 秒预算 |

全部跑满 20 秒，共 8,008 条状态，未跌倒，kick 前零接触。左/右偏侧路径规划长度为 1.7113 / 1.7033 m；末步实际位置约 `(0.0624,0.1542)` / `(0.1399,−0.1563)`，路径剩余约 0.15 / 0.07 m。它们已持续绕行，不能再描述为纯侧移停住；但两项没有 kick，原 20 秒结果仍是未完成。

下一项单独预声明的 26 秒补充计划 只对这两个未完成场景延长时间，控制器不变，结果不能覆盖本表或改判为原矩阵通过。

四段同轮真实录像：近球、[直线远球](approach-left-straight.mp4)、[左偏远球](approach-left-far.mp4)、右偏远球。固定镜头可能使鸭鸭绕行或球滚动时短暂出画；原始坐标记录是位置真相。规划参考路径不等于物理回放。

仍是公开、仿真真值定位、固定现成模型的准备实验，没有视觉感知、球门命中标准、独立验证或正式采用。球场未启用滚动摩擦，长距离滚动不用于版本排名。
