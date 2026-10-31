#!/usr/bin/env python3
"""检查时间轴：镜头从头铺到尾、不留缝，两句话不许叠在一起，声音不许跑出片子。

来源：《醋醋喵》EP0 第 16 条（跨格的长句压在下一句上，字幕叠成两层）。

用法：python3 timeline-check.py timeline.json [--gap 0.3]

timeline.json（时间单位都是帧，整数）：
  {"fps": 30,
   "total": 11796,                                   # 可省略，省略时取最后一个镜头的结尾
   "cuts":   [{"id": "C01", "from_": 0, "dur": 195}, ...],
   "events": [{"k": "line" | "sub", "at": 18, "dur": 160, "text": "..."},
              {"k": "sfx", "at": 1089, "dur": 12}, ...]}   # sfx 的 dur 可省略

查什么
  - 结构：fps、镜头、事件的字段齐全，数字是非负整数（镜头和台词的时长要大于 0）。
  - 镜头：第一个从 0 开始，一个接一个，最后一个正好结束在全长上。
  - 台词（line 配音、sub 只有字幕）：两句之间至少空 --gap 秒，不许重叠，不许超出全长。
  - 所有事件：起点在第 0 到第 total-1 帧之间，结尾不超过 total。
  - 其他事件类型一律报错，免得写错的类型被悄悄跳过。
退出码：0 没有问题；1 有要改的地方（包括格式不对）；2 命令行参数不合法（比如 --gap 是负数或 nan）。适合放在渲染前。
"""
import argparse
import json
import math
import sys
from pathlib import Path

SPEECH = ("line", "sub")
KINDS = SPEECH + ("sfx",)


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def check(d, gap_seconds):
    problems = []
    if not isinstance(d, dict):
        return ["时间轴要是一个 JSON 对象"], None
    fps = d.get("fps")
    if not (isinstance(fps, (int, float)) and not isinstance(fps, bool) and math.isfinite(fps) and fps > 0):
        return [f"fps 要是有限的正数，现在是 {fps!r}"], None

    cuts = d.get("cuts")
    if not isinstance(cuts, list) or not cuts:
        return ["cuts 要是一个非空数组"], None
    for i, c in enumerate(cuts):
        name = c.get("id", f"第 {i + 1} 个镜头") if isinstance(c, dict) else f"第 {i + 1} 个镜头"
        if not isinstance(c, dict) or not is_int(c.get("from_")) or not is_int(c.get("dur")):
            problems.append(f"{name}：from_ 和 dur 要是整数帧")
        elif c["from_"] < 0 or c["dur"] <= 0:
            problems.append(f"{name}：from_ 不能为负，dur 要大于 0")
    if problems:
        return problems, None

    end_of_cuts = cuts[-1]["from_"] + cuts[-1]["dur"]
    total = d.get("total", end_of_cuts)
    if not is_int(total) or total <= 0:
        return [f"total 要是正整数帧，现在是 {total!r}"], None

    if cuts[0]["from_"] != 0:
        problems.append(f"片头空了：第一个镜头 {cuts[0].get('id')} 从第 {cuts[0]['from_']} 帧才开始")
    for prev, cur in zip(cuts, cuts[1:]):
        if prev["from_"] + prev["dur"] != cur["from_"]:
            problems.append(f"镜头有缝或重叠：{prev.get('id')} 结束在 {prev['from_'] + prev['dur']}，"
                            f"{cur.get('id')} 从 {cur['from_']} 开始")
    if end_of_cuts != total:
        problems.append(f"镜头没铺满：最后一个镜头结束在第 {end_of_cuts} 帧，全长是 {total} 帧")

    events = d.get("events", [])
    if not isinstance(events, list):
        return problems + ["events 要是一个数组"], None
    speech = []
    for i, e in enumerate(events):
        label = f"第 {i + 1} 个事件"
        if not isinstance(e, dict):
            problems.append(f"{label}要是一个对象")
            continue
        k = e.get("k")
        if k not in KINDS:
            problems.append(f"{label}的类型 {k!r} 不认识（只认 {', '.join(KINDS)}）")
            continue
        if k in SPEECH and not isinstance(e.get("text", ""), str):
            problems.append(f"{label}：text 要是文字")
            continue
        text = str(e.get("text", ""))[:16]
        label = f"{label}「{text}」" if text else f"{label}（{k}）"
        at = e.get("at")
        dur = e.get("dur", 0 if k == "sfx" else None)
        if not is_int(at) or not is_int(dur):
            problems.append(f"{label}：at 和 dur 要是整数帧")
            continue
        if at < 0 or dur < 0 or (k in SPEECH and dur == 0):
            problems.append(f"{label}：at 不能为负，dur 要大于 0")
            continue
        if at >= total or at + dur > total:
            problems.append(f"{label}跑出了片子：从第 {at} 帧开始、到第 {at + dur} 帧结束，"
                            f"片子只有第 0 到第 {total - 1} 帧")
        if k in SPEECH:
            speech.append(e)

    speech.sort(key=lambda e: e["at"])
    for prev, cur in zip(speech, speech[1:]):
        free = (cur["at"] - (prev["at"] + prev["dur"])) / fps
        if free < 0:
            problems.append(f"重叠 {-free:.2f}s：「{prev.get('text', '')[:16]}」还没说完，「{cur.get('text', '')[:16]}」就开始了"
                            f"（{prev['at'] / fps:.1f}s → {cur['at'] / fps:.1f}s）")
        elif free < gap_seconds:
            problems.append(f"太挤 {free:.2f}s：「{prev.get('text', '')[:16]}」和「{cur.get('text', '')[:16]}」之间"
                            f"（{cur['at'] / fps:.1f}s）")
    return problems, (len(cuts), len(speech), total / fps)


def non_negative_seconds(s):
    v = float(s)
    if not math.isfinite(v) or v < 0:
        raise argparse.ArgumentTypeError("要是有限的非负秒数")
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("timeline")
    ap.add_argument("--gap", type=non_negative_seconds, default=0.3, help="两句话之间至少空几秒（有限、非负）")
    a = ap.parse_args()
    try:
        d = json.loads(Path(a.timeline).read_text())
    except (OSError, ValueError) as e:
        print(f"时间轴读不了：{e}")
        sys.exit(1)
    problems, summary = check(d, a.gap)
    if summary:
        n_cuts, n_speech, seconds = summary
        print(f"{n_cuts} 个镜头，{n_speech} 句话，全长 {seconds:.1f} 秒")
    for p in problems:
        print("  " + p)
    print("没有问题" if not problems else f"{len(problems)} 处要改")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
