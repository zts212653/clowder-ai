---
doc_kind: report
feature_ids: [F311]
topics: [football, turning, diagnosis]
created: 2026-09-07
status: observed-forward-arc-basis
---

# 保持前进时能持续拐弯；原地转向只给瞬态

T1 Sol（GPT-5.6 Sol）执行两项冻结对照，Astra 读取原脚本、receipt 并核验 SHA 后归档。相同 reset、模型、球场与右偏远球位置 `[0.3,−0.2]`，standing 1 秒后发命令，无外力，8 秒。两项都切到 walking，零球接触、未跌倒。

| vx / vy / wz 命令 | 1–8 s yaw 变化 rad | 4–8 s yaw 变化 rad | 后段 yaw rate rad/s | 持续转向 |
|---|---:|---:|---:|---|
| 0 / 0 / +0.8 | +0.12322 | +0.00467 | +0.000084 | 否 |
| +0.25 / 0 / +0.8 | +3.22876 | +1.99642 | +0.52087 | 是 |

v3 必须保持向前步态，用朝向反馈走弧线；“原地转、再直走”仍会进入未持续运动的区间。这轮只测正 yaw；负向响应、闭环路径收敛、最后对齐与 20 秒内触球，都仍需原八个足球场景实跑。规划半径 0.22 m 是据此提出的设计值，不能把单段弧线响应叫作已验证的全局运动学模型。

来源：`[thread-id]#private-source-id`，root 源码 `d41d40b9ff1082c256982bffb870090023a0351f`。原始 index.json SHA-256 `cbf0493ba29e017bc98398265e4da7f89db96928c7d9bfe66528cd96300dc330`；run_yaw_probe.py SHA-256 `8d03bf187e7553eddd61e902f1924631bbc1b58db9cfb20bb60b6047ec7f86fe`。执行命令、采样时刻与后段持续性判据见原件；这是基础能力诊断，不能计入足球成功率或正式采用证明。
