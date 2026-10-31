---
doc_kind: guide
feature_ids: [F311]
topics: [microduck, football, preparation, telemetry]
created: 2026-09-07
status: public-preparation-probe
tips_exempt: Isolated roadshow physics/telemetry experiment; does not add a Hub capability or change production behavior.
---

# 足球准备探测器

用官方现成 walking / standing / 左右踢球 ONNX，在真实 MuJoCo + BAM M6 中验证足球动作的起点。这里不训练网络、不签发采用或独立验证，也不修改原 walking 实验。operator 总目标仍是鸭鸭学会踢足球；本切片先交付能复跑的球状态、触球、关节动作和真实画面。

**2026-09-09 演示数据入口**：真实谱系、GT 与完整结果，包含 v4 及本次十二场公开球位补测。共五个控制器版本、八轮测量、56 场记录、54,256 条状态与 24 段录像；重复轨迹和窗口前缀不计作独立样本。可直接读取 JSON/CSV、原件与训练准备说明，补测不生成新版本，也不代表正式足球验收。

来源锁在 probe-plan.json：官方 [模型库 088524a64e2557dc453256b6071dbb9d23888802](https://huggingface.co/pollen-robotics/microduck-policies/tree/088524a64e2557dc453256b6071dbb9d23888802) 与 `microduck_rl@29e887ecfbf5d37144759e5a9f8a176dfb83d547`。四个 ONNX 和官方 manifest 均逐字节核 hash；walking ONNX 与原行走实验相同。场景与 include 链也核 hash。

两个待观察的动作持续时间来自真实来源：官方模型 manifest 的 0.5 秒与该版本 `infer_policy.py` 命令行默认的 3 秒。左右脚各自比较，另有不踢球、远球和向前偏移 15 mm 的对照；完整 10 个公开 case 在首次物理运行前提交。它们是公开准备探测，不是密封样本、正式候选或 operator 已冻结的足球验收标准。

原示范的 kick trigger 会把球重置到脚前。本适配器仅在回合初始化摆球，触发动作保持全部物理位置/速度不变。回归测试先在原触发器上失败（球 XY 从 0.3/0.2 变成 0.09/0.042），再在适配器上通过。这能避免把重置球的位置算成主动接近或踢球成果。

## 运行

需要 Python 3.12、`numpy==2.4.1`、`mujoco==3.10.0`、`onnxruntime==1.24.4`、`better-actuator-models==1.0.1`；视频另用 ffmpeg。本探测明确使用 PyPI BAM 1.0.1，不把包版本说成已验证的 git commit。源码 checkout 必须处于上述 exact revision 且 clean。

在本目录，使用装好依赖的 Python：

```bash
python fetch_assets.py /tmp/microduck-football-assets
F311_SOURCE_ROOT=/path/to/microduck_rl python -m unittest discover -p 'test_*.py' -v
python run_probe.py --source-root /path/to/microduck_rl --assets /tmp/microduck-football-assets \
  --output /tmp/microduck-football-run \
  --video-case left-manifest --video-case left-cli-default \
  --video-case right-manifest --video-case left-far
```

输出目录必须不存在，拒绝覆盖历史结果。无需启动 Clowder AI 服务、访问 Redis、联网推理或训练。

## 可读的记录

- `index.json`：精确输入、源码文件 hash、实际代码 HEAD/dirty 状态、环境、模型 61→14 shape 与每个 case 的测量。不是 F267 proof 或 F246 Approval。
- 每个 `.json.gz`：50 Hz 球位置/姿态/线速度/角速度、机器人位置/姿态、关节位置/速度、61 维动作前观测、14 维 raw action、目标关节角度与电机扭矩。gzip 与解压内容均有 hash。
- 200 Hz 物理子步触球记录：只有球与机器人接触，包含机器人 body、几何间距与接触法向力；球碰地不算触球。准备阶段接触与动作触发后的接触分开。
- `.mp4` 与 PNG：直接来自该回合 MuJoCo renderer；未用 AI 生成或回放重建画面。画面与 JSON 同一轮产生。

测量从触发前的 1 秒时刻起算：球沿目标方向的带符号位移、侧向位移、最大速度、首次触球与是否触发既有跌倒判据。准备期就倒地会返回测量不可用。探测没有“足球成功”标签；站立控制、动作长短、球位置的差异必须看完整表与回放，不按最好的一条截取结论。

## 已跑结果与走近控制链

首轮完整结果 (internal) 包含 10 场景、4,010 条状态、4 段真实录像：近球能踢，远球不动；0.5 s / 3 s 没有球轨迹增益。接触计数是物理子步记录数，不是踢球次数。原场景 `condim=3` 未启用滚动摩擦，长距离滚动不能用作真实射程或策略优劣证明。

approach-plan.json 在执行前冻结 8 个 20 秒公开场景：两项远球原地踢对照，以及左右脚各自的近球、正前方远球、侧前方远球。`ApproachController` 直接读取 MuJoCo 球位置和机器人姿态，转成机器人坐标中的目标位置误差，发出有界 walking 速度指令；到脚前窗口后切 standing 停稳，触发一次固定 kick，之后站立观察。它没有相机识别、噪声鲁棒性或新网络训练。阈值是探测控制器参数，未被声明为 operator 的足球成功标准。

```bash
python run_probe.py --plan approach-plan.json --source-root /path/to/microduck_rl \
  --assets /tmp/microduck-football-assets --output /tmp/microduck-approach-run \
  --video-case approach-left-far --video-case approach-right-far \
  --video-case approach-left-straight --video-case approach-left-near
```

Schema 2 轨迹额外保存每步实际动作前的上层决策、速度命令、坐标误差和特权球状态来源；事件记录阶段切换与实际踢球触发时间。全段球位移、触发前接触、触发后的测量分开，不能把走近时推球算成 kick 改善。仍保留 Schema 1 原始首轮证据，不覆写旧 capture 或 walking 实验。

| 版本 | 改了什么 | 实际结果与取舍 |
|---|---|---|
| v1 (internal) | 球位置反馈，接近/停稳/单次 kick | 近球可踢，远球命令太小而不起步 |
| v2 (internal) | 前进时保持 0.25 m/s 指令 | 直线远球在 5.21 / 5.225 s 触球；偏侧球的纯侧移收尾停住 |
| v3 (internal) | 保持前进，用朝向反馈沿 CSC 弧线走到准备位 | 直线触球；偏侧球持续绕行，但原 20 s 未完成 |
| v3 时间补充 (internal) | 控制器不变，只给两个偏侧场景 26 s | 左右分别于 22.35 / 21.365 s 触球，无提前接触或跌倒；代价是约 21–22 s，不覆盖原超时 |

诊断依据分别为 六项起步对照 (internal)、四项纯侧移 (internal) 和 两项转向 (internal)。当前固定模型/初态下，不能把独立横移与原地旋转当作可持续运动轴；前进加转向已有真实响应。`arc_path.py` 枚举四类 arc–straight–arc 路径，筛掉采样点接近球的准备段，再选其中最短的一条；不宣称全局最短。`ArcApproachController` 按实际位置推进路径，维持前进步态，禁止按时间跳过路程。目标到位才停稳踢；球提前移动或无可用路径会停止并留下明确状态。

用 `--plan approach-v2-plan.json`、`approach-v3-plan.json` 或 `approach-v3-extended-plan.json` 复现各轮，输出必须是新目录；所有原计划和结果保持原样。截至本节 v3 时间补充累计 36 场景、30,636 条状态、16 段真实录像；基础诊断不计入这些足球场景。后续 v4 和公开球位补测见页首演示数据入口。

归档完整性可独立复核：`python verify_archive.py evidence/20260907-fixed-kicks`（其他四份足球归档同理）。它检查原始/压缩文件 hash、控制时序、数组维度、带符号位移与接触记录计数；不签发独立能力验证或采用证明。v2 视频的独立复跑来源另保存在 `media-run.json`，原数据 index 不覆写。
