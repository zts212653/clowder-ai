---
doc_kind: report
feature_ids: [F311]
topics: [walking, startup, diagnosis, public-experiment]
created: 2026-09-07
status: bounded-cause-identified
---

# 起步边界：0.20 m/s 命令会停住，0.25 m/s 已能走

报告人：T1 Sol（GPT-5.6 Sol），root Astra 读取脚本与原始 receipt 后核对并归档。返回源为 `[thread-id]#private-source-id`。这是一轮六场景的局部诊断，不是足球成功率、正式 eval 或独立采用证明。

## 现象与诊断

走近 v1 的四个远球场景持续输出 walking 命令，20 秒却没有走到。原始动作与同一 walking ONNX 对同一观测的推理精确相同，排除了误用 standing session。假设分别是速度命令、先站立再起步、以及旧实验推扰。诊断固定相同 reset 状态和 pinned 场景/模型，每次只改一项，先声明六场景，再运行。

| 速度命令 | 先站立 | 推扰 | 发命令后前进距离 | 测量时长 |
|---|---:|---|---:|---:|
| 0.20 m/s | 1 s | 无 | 0.006507 m | 7 s |
| 0.25 m/s | 1 s | 无 | 0.493591 m | 7 s |
| 0.30 m/s | 1 s | 无 | 0.694776 m | 7 s |
| 0.25 m/s | 0 s | 无 | 0.550011 m | 约 8 s |
| 0.25 m/s | 1 s | 原公开 3/6 s 推扰 | 0.532546 m | 7 s |
| 0.25 m/s | 0 s | 原公开 3/6 s 推扰 | 0.567030 m | 约 8 s |

“立即 walking”两项的距离测量从第一个控制步后的 0.02 秒开始，故此处写“约 8 s”；精确末位置在 index.json。全部存活。最后一项 terminal x/z/body-forward velocity 与旧公开 seed-1 trace 完全一致，验证了本诊断与旧 runner 的对应关系。速度最大值字段只覆盖脚本记录的采样时刻，不宣称是全物理子步最大值。

## 根因与动作

同一 standing 后起步条件下，仅把命令从 0.20 改为 0.25 m/s，运动恢复；因此先站立和缺少推扰不是本次静止的原因。此轮只把起步响应区间夹在 `(0.20, 0.25]`，没有确定精确阈值。v1 的最大纵向命令 0.20、接近时又衰减到 0.06，持续请求了未启动步态的区间。

基于最小已测试可动值，v2 在纵向误差尚未进入停步窗口时使用至少 0.25 m/s 的指令；到位再发零命令、停稳后踢。保留准备一秒、无推扰、原模型与物理场景；不加外力帮助、不把球搬近。负向、侧向、yaw 与精细停步的组合收敛仍需原八个足球场景验证，不能从直线诊断外推为已会踢远球。

## 复现与来源

run_boundary_probe.py 为 Sol 的原诊断脚本，SHA-256 `1c10da5bd9bc8b922e542f72be9e557050663944e8948b39cafcbad0e89f3ec6`；index.json SHA-256 `00fdfb66fc0417f1cd00189b516cd7a9341167c9308638868e464bc7b63757cb`。依赖与四模型 hash 均在 receipt 中。脚本引用同仓 football 运行基础，首次运行使用 root probe `4676e72d2a42d120fdb0cc3c1a3e51641b8234e1`。

```bash
python run_boundary_probe.py --football-root /path/to/pipeline/football \
  --source-root /path/to/microduck_rl --assets /tmp/microduck-football-assets \
  --output /tmp/microduck-startup-diagnostic
```

首次 run-a 六个物理场景已经跑完，但 receipt 保存因 macOS `/tmp` 与 `/private/tmp` 的路径别名差异失败；只修正 resolved source path 后相同矩阵重跑，成功 receipt 为 run-b。没有挑选重跑中的较好结果。
