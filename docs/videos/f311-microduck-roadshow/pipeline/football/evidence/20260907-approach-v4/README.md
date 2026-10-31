---
doc_kind: report
feature_ids: [F311]
topics: [football, approach, radius, public-experiment, negative-result]
created: 2026-09-07
status: observed-partial-improvement-left-kick-missed
---

# v4：路线缩短，右侧在 20 秒内踢中，左侧踢空

**取舍：不能把这一档称为双侧踢球的完整改善。** 只把规划半径从 0.22 m 缩到 0.18 m 后，两侧路线都短了约 0.25 m，右偏远球在 18.905 秒实际触球；左侧虽在 18.9 秒触发踢腿，整场没有触球。保留这项局部改善和反例，不继续在同一轮改参数到过线。

执行前冻结的计划来自实施计划。真实运行 source `ca49d8ca97dd840ef54e70a39d63d20625fc16ea`、启动时 clean；8 场景、20 秒、全部固定官方模型、球位、物理、速度上限、staging、0.6 秒停稳阶段和 0.5 秒 kick 都与 [v3](../20260907-approach-v3/README.md)相同。递归比较 plan、忽略明确标注的版本说明后，唯一行为字段差异为 `approachController.arc.radiusM`。模型契约、环境与依赖对象逐项全等。

执行入口另加了新计划名的固定 allowlist 登记，没有改仿真循环。首次命令在参数解析阶段 exit 2，零物理运行、输出目录未创建；修复后同一参数完整执行 exit 0、耗时 24 秒。本页只报告后一次真实运行，不把第一次 CLI 拒绝当作实验失败或成功。

## 完整八场景

| 场景 | v3 首次触球 s（20 秒） | v4 kick s | v4 首次触球 s（20 秒） | kick 前接触 | 跌倒 |
|---|---:|---:|---:|---:|---|
| direct-left-far | 无 | 1.00 | 无 | 0 | 无 |
| direct-right-far | 无 | 1.00 | 无 | 0 | 无 |
| approach-left-near | 1.720 | 1.62 | 1.720 | 0 | 无 |
| approach-right-near | 1.730 | 1.62 | 1.730 | 0 | 无 |
| [approach-left-straight](approach-left-straight.mp4) | 4.700 | 4.60 | 4.700 | 0 | 无 |
| [approach-right-straight](approach-right-straight.mp4) | 4.705 | 4.60 | 4.700 | 0 | 无 |
| [approach-left-far：踢空](approach-left-far.mp4) | 无 | 18.90 | 无 | 0 | 无 |
| [approach-right-far：踢中](approach-right-far.mp4) | 无 | 18.80 | 18.905 | 0 | 无 |

每场 1,001 条状态，共 8,008 条；所有场景完整保留，没有挑选成功后重跑。direct 两场对照与 near 两场的解压 capture SHA 分别与 v3 完全相同。两场 straight 的轨迹不逐字节相同，但触球时间没有实质退步；不把它们写成同轨。

真实接触均由对应侧 `ankle_left` / `ankle_right` body 产生；两个 direct 和左偏远球没有机器人-球接触。既有禁止触发器搬球的守卫保持，原始 kick 事件全部 `ballRelocated=false`。

## 缩短了什么，为什么仍不能选作完整改善

| 偏侧球 | v3 规划长度 m | v4 规划长度 m | v4 进入停稳阶段 s | v4 结果 |
|---|---:|---:|---:|---|
| 左 | 1.7113025102 | 1.4592401384 | 18.28 | 到位后踢空 |
| 右 | 1.7032939503 | 1.4526690973 | 18.18 | 18.905 秒触球 |

这些是规划长度，不是由录像估算的实际行走距离。原 v3 的 20 秒未完成结果仍不改判；其独立 [26 秒补充](../20260907-approach-v3-extended/README.md)中左右分别于 22.350 / 21.365 秒触球，作为完整历史保留，不替换本轮 20 秒对照列。

左侧 raw trace 给出下一步的具体线索：进入停稳阶段后，机器人继续向前漂移。kick 决策时，body-frame 目标误差为 `[-0.0246054, +0.0009257] m`，yaw 误差 `-0.157979 rad`；宽停稳窗口仍允许触发。相同一脚在此前 v3 时间补充中的纵向误差为 `+0.0095809 m`。位置与朝向偏差是同场可见线索，尚无干预对照把它们逐一确认为踢空原因。不能靠事后放宽“碰到/踢中”标准宣布改善。

全局配置选择仍保持未选择；右侧结果可作为后续独立验证的准备材料。球场没有滚动摩擦，最终球滚动距离不用于策略排名或射程承诺。没有新网络训练、视觉找球、正式足球验收或采用。

## 录像与复核

四段 MP4 均是本轮 MuJoCo renderer 的同场采集：640×480、10 fps、201 帧、20.1 秒（含 reset 帧）。不是生成视频，也不是用轨迹重建的表演。Astra 已目视左右远球 18.8 / 19.2 秒原视频帧：左侧球仍在脚前，右侧球已离脚向前运动；这些帧只支持可见现象，接触与全程未跌倒由完整状态及接触记录判断。

- 左侧：18.8 秒 → 19.2 秒
- 右侧：18.8 秒 → 19.2 秒
- index.json SHA-256：`ca3f985fccf51bdddba0a050677fdf83694940659c2085401332ea7a9f73fab3`
- archive-manifest.json：保护 33 个原始运行文件和上述 4 张视频截帧；后者的来源方法与取帧时间单列。

`verify_archive.py` 实跑通过：37 文件、8 episodes、8,008 samples；逐项核 raw/compressed SHA、数组维度、控制时序、接触计数与 signed displacement。Python 行为/完整性 tests 17/17，通过不等于 v4 改善假设成立；该假设因左侧仍未触球而不满足本轮预声明的整体接受条件。

此归档尚需沿原 Workspace 材料发布链进入产品，不由 Git 落盘或 Chat 回放推导用户已经可见。
