---
doc_kind: report
feature_ids: [F311]
topics: [football, approach, public-experiment]
created: 2026-09-07
status: observed-straight-approach-improved
---

# 走近控制 v2：正前方远球已能走近后踢，侧向收尾仍未完成

基于 [T1 单变量诊断](../20260907-walking-startup/README.md)，本版只把纵向命令上限与最低非零值设为 0.25 m/s，其他参数、模型、场景和原八个 case 保持不变。原 [v1](../20260907-approach-v1/README.md) 不覆写。完整计划在 index.json 内，源文件为 approach-v2-plan.json。

八场景均跑满 20 秒，共 8,008 条状态，未触发既有跌倒判据。正前方远球左右脚均在 5.1 秒触发 kick、5.21 / 5.225 秒接触，触发前零接触：这两项已从“原地不动”变成“先走近再踢”。左右偏侧远球纵向已接近目标，但侧向还差约 5.5 / 7.4 cm，未触发 kick。

| 场景（原始记录） | 机器人前移 m | 侧移 m | kick 触发 s | 首次触球 s | 触发前接触记录 |
|---|---:|---:|---:|---:|---:|
| direct-left-far | 0.0247 | 0.0156 | 1 | 未触球 | 0 |
| direct-right-far | 0.0039 | -0.0341 | 1 | 未触球 | 0 |
| approach-left-near | 0.0219 | 0.0158 | 1.62 | 1.72 | 0 |
| approach-right-near | 0.0031 | -0.0340 | 1.62 | 1.73 | 0 |
| approach-left-straight | 0.2187 | 0.0158 | 5.1 | 5.21 | 0 |
| approach-right-straight | 0.1945 | -0.0348 | 5.1 | 5.225 | 0 |
| approach-left-far | 0.2072 | 0.1027 | 未触发 | 未触球 | 0 |
| approach-right-far | 0.2079 | -0.0840 | 未触发 | 未触球 | 0 |

这里的“改善”只指这两个公开正前方场景中的动作链变化，不是泛化成功率、球门命中、视觉找球或正式采用。仍读 MuJoCo 真值球位置；场景无滚动摩擦，长距离滚动不作为优劣判据。

偏侧球的末步真实命令分别约为 `(0, 0.0831, -0.0132)` 和 `(0, -0.1112, -0.0087)`，横向 P 命令衰减后停住。[四项纯横向对照](../20260907-lateral-boundary/README.md) 已确认 ±0.25 命令仍不能持续侧移；[转向对照](../20260907-yaw-boundary/README.md) 则发现保持前进时能持续走弧线。v3 据此改路径坐标，不能照搬纵向 floor 到侧向。

运行源码为 `66e44d00b181567854812439d144bf5128dc7da0`，开始时工作树 clean；index 中全部 codeFiles hash 已逐一对照该 Git commit 验证。随后仓库 gate 纯 rebase 不改这份运行凭据。归档 archive-manifest.json 与 capture 双 hash 均可复核。

已补入 [直线接近录像](approach-left-straight.mp4) 和 [侧向未完成录像](approach-left-far.mp4)。它们由 T1 Sol（GPT-5.6 Sol）在 `d41d40b9ff1082c256982bffb870090023a0351f` clean 源码上按原参数另跑，完整执行凭据保留为 media-run.json，不改原 index 的 `video: null`。两份解压 capture SHA 与原场景逐字节相同：直线 `ade09ab046eb5735200fa95ffea355158db2720b7f8893dd4ecebbfc1881017a`、侧向 `f371cffa0673a258590e3da2adeebc9a5dd2395d47988e37bb1547fd86bfd7ce`。两段均为真实 MuJoCo 渲染，640×480、10 fps、201 帧、20.1 秒（含 reset 帧）；物理测量时长为 20 秒。来源：`[thread-id]#private-source-id`。
