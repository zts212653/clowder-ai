---
doc_kind: report
feature_ids: [F311]
topics: [football, preparation, telemetry, public-experiment]
created: 2026-09-07
status: observed-not-adopted
tips_exempt: Public experiment evidence, not a new Hub capability or user guide.
---

# 足球准备：近球能踢，远球尚不能接近

本轮完成真实 MuJoCo + BAM M6 仿真 10 个公开场景，每个 8 秒、401 条状态，共 4,010 条；全部保留，不筛选最好的一次。它验证现成左右踢球动作能否触到球、记录是否可靠。没有新增网络训练，没有正式足球验收、独立验证或采用结论。

## 看得到的准备

- 环境：官方 `microduck_rl@29e887ecfbf5d37144759e5a9f8a176dfb83d547` 的带球场景及 include 链；球直径 70 mm、质量 15 g。实际运行依赖、场景 hash、模型 shape 与采集器代码 hash 均在 [index.json](index.json)。
- 模型：官方 [Microduck policies@088524a64e2557dc453256b6071dbb9d23888802](https://huggingface.co/pollen-robotics/microduck-policies/tree/088524a64e2557dc453256b6071dbb9d23888802) 的 standing / kick-left / kick-right；walking 同批下载并核验，但本轮未用于动作推理。全部模型固定，61 维输入、14 维输出。
- Harness：50 Hz 模型控制、200 Hz 物理与触球采样；球只在回合 reset 摆放。移除并实测防止 upstream kick trigger 自动把远球搬到脚边。
- 数据：每个 case 可直接打开压缩原始轨迹，含球和机器人 XYZ/姿态/速度、14 关节状态、61 维动作前观测、14 维动作/目标角与最后物理子步扭矩。
- 画面：[左脚近球](left-manifest.mp4)、[左脚远球](left-far.mp4)、[右脚近球](right-manifest.mp4)、[左脚 3 秒对照](left-cli-default.mp4) 均在同轮仿真由 MuJoCo renderer 产生；每段约 8 秒，球可能滚出固定镜头。PNG 命名 t060 表示第 60 个控制步，即 1.2 秒。

## 全部结果

距离是球从 1 秒测量起点到回合结束沿世界 +X / +Y 的位移；接触数是 **200 Hz 子步中的接触记录数，不是踢了几脚**。首次触球时间从回合 reset 起算；跌倒列沿用既有姿态/高度与连续步数判据。

| 场景（链接为原始记录） | 向前 m | 侧向 m | 首次触球 s | 接触记录数 | 跌倒判据 |
|---|---:|---:|---:|---:|---|
| [站立／左侧近球](stand-left-a1e825082bcfb790ad44e35a26319a70939e7c0e9a223b222e620038097ee1c4.json.gz) | 0.000 | -0.000 | — | 0 | 未触发 |
| [站立／右侧近球](stand-right-87115937f8e6a2afcbdd086c2cf0b1be91fe4f2db1432565cb0ae1c7bdfb5a89.json.gz) | 0.000 | -0.000 | — | 0 | 未触发 |
| [左脚／官方 0.5 s](left-manifest-dc4dd22757e77b73e7f9dbb5d4af11c21985488930bc1252ba6524ee79f96951.json.gz) | 4.757 | 0.872 | 1.100 | 7 | 未触发 |
| [左脚／CLI 3 s](left-cli-default-5e691ceb1d507f4173d61d6c4702e209231c3f87b481e70a22e1d42668ec913d.json.gz) | 4.757 | 0.872 | 1.100 | 7 | 未触发 |
| [右脚／官方 0.5 s](right-manifest-0d9307e547ac76d0ff792096232fd18c8ac847ffacadb2a5a6913bf87ea302a4.json.gz) | 3.907 | -0.968 | 1.110 | 6 | 未触发 |
| [右脚／CLI 3 s](right-cli-default-ba15a1ca9fcd204d6ad61287ccfcba54b3f728d9e423eb3ad064df4ab5d65b93.json.gz) | 3.907 | -0.968 | 1.110 | 6 | 未触发 |
| [左脚／远球](left-far-8d4139915bdf5adc97eabfd1bcd4072302034b918f9d75c33018df1eafb35b42.json.gz) | 0.000 | 0.000 | — | 0 | 未触发 |
| [右脚／远球](right-far-cd9796f26a42af7af0ec935c11f67278b7d28ea8636bb671ecbecc84a651392b.json.gz) | 0.000 | 0.000 | — | 0 | 未触发 |
| [左脚／前移 15 mm](left-forward-offset-2d685a366a98b62474fe6fc3c65d2d32625aeb18459e21315e534c3054313c89.json.gz) | 3.196 | 0.431 | 1.115 | 6 | 未触发 |
| [右脚／前移 15 mm](right-forward-offset-572d148edd1394471129e1d5fdf37b25832305ff0690a3f4cc6cef416858a800.json.gz) | 1.199 | -0.449 | 1.130 | 4 | 未触发 |

## 尝试了什么，怎样取舍

1. **不踢球**：两侧球均不动，建立球不会自行前进的对照。
2. **动作持续 0.5 s 与 3 s**：来源分别为官方模型 manifest 与同版上游 CLI 默认值。左右脚各自的球轨迹完全相同，不能宣称缩短持续时间带来增益。后续沿用 0.5 s 只是对齐官方 manifest。
3. **近球与远球**：近球能触到；远球 (0.30, ±0.20) m 完全未触到。说明本轮只有原地踢动作，缺少走近与对齐。未用自动摆球掩盖失败。
4. **球前移 15 mm**：仍触球，但左右脚位移不同，右侧尤其敏感。公开探测不能作为成功率或泛化估计；每个场景只有一轮。

## 物理与证据限制

编译后的球和地面 `condim` 均为 3。XML 虽写了 rolling friction 系数，这种接触维数只包含法向和滑动摩擦；[MuJoCo 官方接触模型说明](https://mujoco.readthedocs.io/en/3.9.0/computation/index.html#condim) 解释了 `condim=6` 才添加滚动摩擦。因此这里 4.757 m 等长距离不能解释成真实机器人的射程，也不能仅凭最终距离给足球策略排名。本轮保持原场景，明确暴露这个环境准备缺口。

“接触”是求解器的接触记录，附几何距离与法向力；原始记录还保留准备期接触。没有相机找球、球门命中、多鸭协作、密封样本或真实机器人证据。接下来在同一模型上验证可见的走近/对齐/踢球控制链，同时保留这些失败对照；总任务仍开放。

采集源码提交：`dc2834176d6cbd49014bab5d7649f1bb347e391d`，运行时工作树 clean。冻结计划见 index 内嵌 plan；[archive-manifest.json](archive-manifest.json) 校验全部原始文件、录像与截图字节。归档过程未重新计算或覆盖原始结果。复跑命令见 [探测器 README](../../README.md)。
