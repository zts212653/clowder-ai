#!/usr/bin/env python3
"""检查字幕会不会撑出底条：用片子实际的字体和字号，量 .srt 里每一条有多宽。

来源：2026-11-05 审稿人系列 Ep.01 v5（字幕组件 maxWidth 1120 + whiteSpace nowrap，
27 个字的一句没被切开，伸出底条压到右边的猫）和同期记忆系统片都溢出过。

用法：python3 caption-fit-check.py subs.srt --font 字体文件 --size 42 --max-px 960 \
        [--index 0] [--spacing 0.6] [--strip-speaker]

  --max-px   字幕文字能用的宽度：底条最大宽度减去左右内边距、边框、名字条和间距，不是整张画面宽。
  --spacing  CSS letter-spacing（像素），每个字加一次。
  --index    .ttc 字体集里的第几个字体（粗细不同时选对那一个）。
  --font default  用 Pillow 自带字体，只给测试用，没有中文字形。
  --strip-speaker  去掉每条开头的「名字：」，名字条单独画在左边时用。
.srt 里一条有几行就逐行量。

退出码：0 都放得下；1 有放不下的，或文件读不了；2 命令行参数不对。适合放在渲染前。
"""
import argparse
import math
import re
import sys
from pathlib import Path

from PIL import ImageFont

TIMING = re.compile(r"^\s*(\d\d:\d\d:\d\d[,.]\d{3})\s*-->")
SPEAKER = re.compile(r"^[^：:\s]{1,6}[：:]\s*")


def parse_srt(text):
    """返回 [(序号, 开始时间, [行…])]。"""
    cues = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip()):
        lines = block.split("\n")
        for i, ln in enumerate(lines):
            m = TIMING.match(ln)
            if m:
                body = [x for x in lines[i + 1:] if x.strip()]
                if body:
                    cues.append((len(cues) + 1, m.group(1), body))
                break
    return cues


def load_font(path, size, index):
    if path == "default":
        return ImageFont.load_default(size=size)
    return ImageFont.truetype(path, size, index=index)


def positive(s):
    v = float(s)
    if not math.isfinite(v) or v <= 0:
        raise argparse.ArgumentTypeError("要是有限的正数")
    return v


def finite(s):
    v = float(s)
    if not math.isfinite(v):
        raise argparse.ArgumentTypeError("要是有限的数")
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("srt")
    ap.add_argument("--font", required=True)
    ap.add_argument("--size", type=positive, required=True)
    ap.add_argument("--max-px", type=positive, required=True)
    ap.add_argument("--index", type=int, default=0)
    ap.add_argument("--spacing", type=finite, default=0.0)
    ap.add_argument("--strip-speaker", action="store_true")
    a = ap.parse_args()

    try:
        cues = parse_srt(Path(a.srt).read_text(encoding="utf-8"))
        font = load_font(a.font, a.size, a.index)
    except (OSError, ValueError) as e:
        print(f"读不了：{e}")
        sys.exit(1)
    if not cues:
        print("字幕文件里没有找到任何一条")
        sys.exit(1)

    widest, over = 0.0, []
    for n, start, body in cues:
        for ln in body:
            s = SPEAKER.sub("", ln, count=1) if a.strip_speaker else ln
            w = font.getlength(s) + a.spacing * len(s)
            widest = max(widest, w)
            if w > a.max_px:
                over.append(f"第 {n} 条（{start}）宽 {w:.0f}px，超出 {w - a.max_px:.0f}px：「{s}」")

    print(f"{len(cues)} 条字幕，最宽 {widest:.0f}px，能用 {a.max_px:.0f}px")
    for p in over:
        print("  " + p)
    print("都放得下" if not over else f"{len(over)} 行放不下：切短、允许换行，或调宽底条")
    sys.exit(1 if over else 0)


if __name__ == "__main__":
    main()
