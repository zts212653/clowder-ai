---
doc_kind: report
feature_ids: [F311]
topics: [football, locomotion, diagnosis]
created: 2026-09-07
status: observed-no-sustained-lateral-motion
---

# 纯侧移不能照搬纵向起步阈值

T1 Sol（GPT-5.6 Sol）执行冻结的四项对照，Astra 读取原脚本、receipt 并核验 SHA 后归档。相同 reset、模型、球场，standing 1 秒后只给 lateral 命令，`vx=wz=0`，无外力，8 秒。四项均切到 walking 且未跌倒。

| vy 命令 m/s | 发命令后世界 Y 位移 m | 后段有向 body-vy m/s | 持续侧移 |
|---:|---:|---:|---|
| +0.15 | +0.002215 | +0.000145 | 否 |
| +0.25 | +0.004604 | +0.000107 | 否 |
| −0.15 | +0.000553 | −0.000112 | 否 |
| −0.25 | −0.001228 | −0.000073 | 否 |

加到 ±0.25 仍只是毫米级瞬态，约两秒后关节速度收敛到近静止；正负方向也不对称。因此 v2 的最后侧向收尾不能靠复制纵向 floor 解决。这里支持改为前进/朝向路径，但当时尚未验证 yaw 能力；后续结果见 [yaw 对照](../20260907-yaw-boundary/README.md)。

来源：`[thread-id]#private-source-id`，root 源码 `d41d40b9ff1082c256982bffb870090023a0351f`。原始 index.json SHA-256 `d979b4d4cd71c07f9fa121a6bf32232bcb0c803459471a9366be3e3cd401e99b`；run_lateral_probe.py SHA-256 `d48a9cdb93c4801b77032c8cf865fdfe25e73336bb9c85a8f9daebf8cb2f4ccb`。执行命令、冻结矩阵、13 个记录时刻和持续性判据均在原件中；这是诊断采样，不是完整逐控制帧足球数据集，也不是正式成功标准。
