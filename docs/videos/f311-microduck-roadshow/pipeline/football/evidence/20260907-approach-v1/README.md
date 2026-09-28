---
doc_kind: report
feature_ids: [F311]
topics: [football, approach, preparation, public-experiment]
created: 2026-09-07
status: observed-approach-not-achieved
---

# 走近控制 v1：命令到了，远球还没走到

本轮按执行前冻结的 approach-plan.json 运行 8 个场景，每轮 20 秒，全部保留，共 8,008 条状态。源码 `4676e72d2a42d120fdb0cc3c1a3e51641b8234e1`，运行时 clean。完整环境、参数、代码 hash 和每轮测量见 index.json。

控制链读取 **MuJoCo 真值球位置和机器人姿态**，发出有界 walking 命令，到预定脚前窗口后切 standing 停稳 0.6 秒，再触发一次原有 kick。没有新网络训练，也没有相机感知或噪声测试。

## 全部场景

机器人位移从回合 1 秒起算。触发与首次触球时间均从 reset 起算；最后一列是触发前的物理子步接触记录数，避免把走近时推球算成 kick。

| 场景（原始记录） | 机器人前移 m | 机器人侧移 m | kick 触发 s | 首次触球 s | 触发前接触记录 |
|---|---:|---:|---:|---:|---:|
| direct-left-far | 0.0247 | 0.0156 | 1 | 未触球 | 0 |
| direct-right-far | 0.0039 | -0.0341 | 1 | 未触球 | 0 |
| approach-left-near | 0.0219 | 0.0158 | 1.62 | 1.72 | 0 |
| approach-right-near | 0.0031 | -0.0340 | 1.62 | 1.73 | 0 |
| approach-left-straight | 0.0064 | 0.0065 | 未触发 | 未触球 | 0 |
| approach-right-straight | 0.0064 | 0.0065 | 未触发 | 未触球 | 0 |
| approach-left-far | 0.0093 | 0.0047 | 未触发 | 未触球 | 0 |
| approach-right-far | 0.0066 | 0.0012 | 未触发 | 未触球 | 0 |

近球左右脚都完成了停稳—kick—触球，但四个远球场景持续处于 approach，未进入 kick。两项原地远球对照也没有触到球。全部 8 轮都未触发既有跌倒判据；这不能替代“走到球前”的要求。

## 可见执行与数据样本

- 左侧远球真实录像：上层持续发 walking 指令，鸭鸭近乎原地站立。
- 右侧远球真实录像、[正前方远球录像](approach-left-straight.mp4) 与 [近球停稳后踢球](approach-left-near.mp4) 保留完整 20 秒。
- 每步 `highLevelDecisionBeforeAction` 包含 stage、实际速度指令、机器人坐标中的目标误差、yaw 误差，以及 `ballStateSource=mujoco_ground_truth`；该决策与 61 维动作前观测、14 维动作和执行后的物理状态在同一记录内。
- 近球左脚在 1.62 秒触发、1.72 秒首次触球；远球无触发时 `postKickMeasurement=null`，不会虚构 kick 后测量。
- archive-manifest.json 保存每份原始文件、视频与截图的字节 hash；旧 [原地踢球首轮](../20260907-fixed-kicks/README.md) 保持原样。

## 定位到哪里

从 `approach-left-straight` 的 2 秒样本核验：同一 61 维观测交给已锁定的 `alpha_walking.onnx`，输出与 capture 的 rawAction 最大差为 0；交给 standing 模型最大差约 0.183。因此这一样本没有把 standing 推理误标成 walking。旧行走场景与带球场景也都 include 同一 `robot_groundcontact.xml`。

仍需区分的变量是：原 walking 从 reset 就发 0.25 m/s，且 3/6 秒带推扰；本轮先站立 1 秒、再从最高 0.20 m/s 命令起步，无推扰。T1 正进行一次有界单变量对照，判断速度命令、起步状态与扰动的影响。当前**没有已确认根因或已修好结论**；不会用改变物理状态来伪造走近。

原场景未启用滚动摩擦的限制仍在，因此 20 秒近球长距离滚动不列为改进依据。没有足球目标验收、独立验证、采用、视觉找球或真实机器人结论。
