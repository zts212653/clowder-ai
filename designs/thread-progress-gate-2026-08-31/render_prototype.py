#!/usr/bin/env python3
"""Render deterministic SVG canvases for the Thread Progress product-experience gate."""

from __future__ import annotations

from html import escape
from pathlib import Path


OUT = Path(__file__).resolve().parent

COLORS = {
    "rail": "#eee7dd",
    "sidebar": "#f7f1e9",
    "chat": "#fdfbf8",
    "canvas": "#fffefa",
    "soft": "#f3ede5",
    "soft2": "#ebe3d9",
    "border": "#e3dbd1",
    "border2": "#d5c9bc",
    "text": "#342d29",
    "secondary": "#665d57",
    "muted": "#8b8179",
    "accent": "#b8754d",
    "accent_soft": "#fbefe7",
    "info": "#4e8399",
    "info_soft": "#edf6f8",
    "success": "#5d885f",
    "success_soft": "#eef6ec",
    "warning": "#ad713d",
    "warning_soft": "#fff4e3",
    "critical": "#a85c4e",
    "critical_soft": "#fff0eb",
    "siamese": "#7a66a4",
    "ragdoll": "#d08b72",
    "maine": "#5b7891",
    "user": "#8a7c72",
    "white": "#ffffff",
}

FONT = "Inter, PingFang SC, Microsoft YaHei, Arial, sans-serif"


class SVG:
    def __init__(self, width: int, height: int, title: str):
        self.width = width
        self.height = height
        self.items = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
            f'viewBox="0 0 {width} {height}" role="img" aria-label="{escape(title)}">',
            "<defs>",
            '<filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">'
            '<feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#3b2d24" flood-opacity=".09"/>'
            "</filter>",
            '<filter id="shadow2" x="-20%" y="-20%" width="140%" height="160%">'
            '<feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#3b2d24" flood-opacity=".12"/>'
            "</filter>",
            "</defs>",
        ]

    def rect(self, x, y, w, h, fill, rx=0, stroke="none", sw=1, opacity=1, filt=None):
        extra = f' filter="url(#{filt})"' if filt else ""
        self.items.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="{sw}" opacity="{opacity}"{extra}/>'
        )

    def line(self, x1, y1, x2, y2, stroke, sw=1, dash=None, opacity=1):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.items.append(
            f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" '
            f'stroke-width="{sw}" opacity="{opacity}"{d}/>'
        )

    def circle(self, cx, cy, r, fill, stroke="none", sw=1, opacity=1):
        self.items.append(
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}" stroke="{stroke}" '
            f'stroke-width="{sw}" opacity="{opacity}"/>'
        )

    def polygon(self, points, fill, stroke="none", sw=1):
        p = " ".join(f"{x},{y}" for x, y in points)
        self.items.append(f'<polygon points="{p}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')

    def path(self, d, stroke, sw=1.5, fill="none", opacity=1):
        self.items.append(
            f'<path d="{d}" stroke="{stroke}" stroke-width="{sw}" fill="{fill}" '
            f'stroke-linecap="round" stroke-linejoin="round" opacity="{opacity}"/>'
        )

    def text(self, x, y, value, size=13, color=None, weight=400, anchor="start", opacity=1, family=FONT):
        color = color or COLORS["text"]
        self.items.append(
            f'<text x="{x}" y="{y}" font-family="{escape(family)}" font-size="{size}" '
            f'font-weight="{weight}" fill="{color}" text-anchor="{anchor}" opacity="{opacity}">'
            f'{escape(str(value))}</text>'
        )

    def finish(self):
        return "\n".join(self.items + ["</svg>"])


def pill(s: SVG, x, y, label, fill, color, w=None, h=24, stroke="none"):
    if w is None:
        w = max(54, 16 + len(label) * 13)
    s.rect(x, y, w, h, fill, rx=h / 2, stroke=stroke)
    s.text(x + w / 2, y + h / 2 + 4, label, 11, color, 600, "middle")
    return w


def avatar(s: SVG, cx, cy, color, label, r=15):
    s.polygon([(cx - r * .66, cy - r * .58), (cx - r * .38, cy - r * 1.06), (cx - r * .08, cy - r * .58)], color)
    s.polygon([(cx + r * .08, cy - r * .58), (cx + r * .38, cy - r * 1.06), (cx + r * .66, cy - r * .58)], color)
    s.circle(cx, cy, r, color, COLORS["white"], 2)
    s.circle(cx - r * .3, cy - r * .08, max(1.3, r * .08), COLORS["white"])
    s.circle(cx + r * .3, cy - r * .08, max(1.3, r * .08), COLORS["white"])
    s.text(cx, cy + r * .55, label, max(8, int(r * .62)), COLORS["white"], 700, "middle")


def icon_chevron(s: SVG, x, y, direction="down", color=None):
    color = color or COLORS["muted"]
    if direction == "down":
        s.path(f"M{x-4} {y-2} L{x} {y+2} L{x+4} {y-2}", color, 1.5)
    elif direction == "up":
        s.path(f"M{x-4} {y+2} L{x} {y-2} L{x+4} {y+2}", color, 1.5)
    elif direction == "left":
        s.path(f"M{x+2} {y-4} L{x-2} {y} L{x+2} {y+4}", color, 1.5)
    else:
        s.path(f"M{x-2} {y-4} L{x+2} {y} L{x-2} {y+4}", color, 1.5)


def truth_label(s: SVG, mobile=False):
    w = 142 if not mobile else 132
    x = s.width - w - (12 if mobile else 16)
    y = s.height - 30
    s.rect(x, y, w, 20, "#3f3732", rx=10, opacity=.82)
    s.text(x + w / 2, y + 14, "功能原型 · 演示数据", 10, COLORS["white"], 600, "middle")


def activity_rail(s: SVG, h=900, active="chat", width=52):
    s.rect(0, 0, width, h, COLORS["rail"])
    s.circle(width / 2, 28, 17, COLORS["accent_soft"], COLORS["accent"], 1.5)
    s.polygon([(18, 27), (21, 17), (26, 23), (31, 17), (34, 27)], COLORS["accent"])
    s.circle(26, 30, 9, COLORS["accent"])
    nav = [(76, "chat"), (124, "recent"), (172, "memory"), (220, "mission"), (268, "signals")]
    for y, key in nav:
        if key == active:
            s.rect(6, y - 20, width - 12, 40, COLORS["canvas"], rx=10, filt="shadow")
        c = COLORS["accent"] if key == active else COLORS["secondary"]
        if key == "chat":
            s.rect(18, y - 8, 16, 13, "none", rx=3, stroke=c, sw=1.5)
            s.path(f"M21 {y+5} L19 {y+10} L25 {y+5}", c, 1.5)
        elif key == "recent":
            s.circle(26, y, 9, "none", c, 1.5)
            s.path(f"M26 {y-5} L26 {y} L31 {y+2}", c, 1.5)
        elif key == "memory":
            s.path(f"M18 {y-7} Q26 {y-12} 34 {y-7} L34 {y+7} Q26 {y+2} 18 {y+7} Z", c, 1.5)
        elif key == "mission":
            s.rect(19, y - 9, 14, 18, "none", rx=2, stroke=c, sw=1.5)
            s.line(22, y - 3, 30, y - 3, c, 1.3)
            s.line(22, y + 2, 29, y + 2, c, 1.3)
        else:
            s.path(f"M19 {y+8} L19 {y-8} Q25 {y-4} 33 {y-8} L33 {y+3} Q25 {y+7} 19 {y+3}", c, 1.5)
    for i, y in enumerate([h - 164, h - 116, h - 68, h - 28]):
        if i == 3:
            s.circle(26, y, 10, COLORS["soft2"])
            s.circle(26, y, 3, COLORS["muted"])
        else:
            s.circle(26, y, 8, "none", COLORS["muted"], 1.3)


def thread_sidebar(s: SVG, x=52, w=240, h=900, active_index=0):
    s.rect(x, 0, w, h, COLORS["sidebar"])
    s.line(x + w, 0, x + w, h, COLORS["border"], 1)
    s.text(x + 18, 34, "对话", 15, COLORS["text"], 700)
    s.rect(x + w - 80, 16, 64, 28, COLORS["accent"], rx=14)
    s.text(x + w - 48, 35, "+ 新对话", 11, COLORS["white"], 700, "middle")
    s.rect(x + 14, 58, w - 28, 34, COLORS["soft"], rx=10, stroke=COLORS["border"])
    s.circle(x + 29, 75, 6, "none", COLORS["muted"], 1.2)
    s.line(x + 33, 79, x + 37, 83, COLORS["muted"], 1.2)
    s.text(x + 44, 80, "搜索对话…", 11, COLORS["muted"])
    tabs = [(x + 24, "最近"), (x + 78, "置顶"), (x + 132, "项目"), (x + 186, "收藏")]
    for i, (tx, label) in enumerate(tabs):
        c = COLORS["accent"] if i == 0 else COLORS["muted"]
        s.text(tx, 116, label, 11, c, 700 if i == 0 else 500, "middle")
    s.line(x + 12, 126, x + w - 12, 126, COLORS["border"])
    s.line(x + 12, 126, x + 66, 126, COLORS["accent"], 2.5)
    threads = [
        ("会话进度视图设计", "烁烁 · 正在推进", COLORS["siamese"]),
        ("Runtime Harness 深入学习", "宪宪 · 12 分钟前", COLORS["ragdoll"]),
        ("Pi session 接续机制", "等待外部结果", COLORS["info"]),
        ("Codex 开源范围调研", "最近有新结论", COLORS["maine"]),
        ("Agent eval 方法论", "3 天前", COLORS["success"]),
    ]
    y = 140
    for i, (title, sub, color) in enumerate(threads):
        if i == active_index:
            s.rect(x + 10, y, w - 20, 66, COLORS["canvas"], rx=12, filt="shadow")
        avatar(s, x + 31, y + 31, color, title[0], 12)
        s.text(x + 52, y + 27, title, 12, COLORS["text"], 650)
        s.text(x + 52, y + 47, sub, 10, COLORS["muted"])
        if i == 0:
            s.circle(x + w - 27, y + 31, 4, COLORS["success"])
        y += 72
    s.text(x + 18, h - 22, "5 个对话 · 演示列表", 10, COLORS["muted"])


def chat_header(s: SVG, x, w, mobile=False, title="会话进度视图设计"):
    h = 58 if mobile else 68
    s.rect(x, 0, w, h, COLORS["chat"])
    s.line(x, h, x + w, h, COLORS["border"])
    if mobile:
        s.path(f"M{x+15} 25 L{x+31} 25 M{x+15} 31 L{x+31} 31 M{x+15} 37 L{x+31} 37", COLORS["secondary"], 1.8)
        s.text(x + 46, 29, "Clowder AI", 14, COLORS["text"], 750)
        s.text(x + 46, 46, title, 10, COLORS["muted"])
        avatar(s, x + w - 27, 29, COLORS["siamese"], "烁", 12)
    else:
        s.polygon([(x + 18, 34), (x + 24, 19), (x + 32, 28), (x + 40, 19), (x + 46, 34)], COLORS["accent"])
        s.circle(x + 32, 38, 14, COLORS["accent"])
        s.text(x + 58, 30, "Clowder AI", 16, COLORS["text"], 750)
        s.text(x + 58, 50, title, 11, COLORS["muted"])
        avatar(s, x + 250, 35, COLORS["ragdoll"], "宪", 12)
        avatar(s, x + 270, 35, COLORS["siamese"], "烁", 12)
        s.rect(x + w - 48, 17, 32, 32, COLORS["soft"], rx=16)
        s.rect(x + w - 39, 24, 14, 16, "none", rx=3, stroke=COLORS["secondary"], sw=1.3)
        s.line(x + w - 31, 24, x + w - 31, 40, COLORS["secondary"], 1.2)
    return h


def progress_collapsed(s: SVG, x, y, w, needs_user=False, mobile=False):
    h = 40
    fill = COLORS["warning_soft"] if needs_user else COLORS["canvas"]
    edge = COLORS["warning"] if needs_user else COLORS["border"]
    s.rect(x, y, w, h, fill, stroke=edge, sw=1)
    s.circle(x + 18, y + 20, 4, COLORS["success"])
    actor = "烁烁正在完成 UI 视觉稿" if not mobile else "烁烁正在做视觉稿"
    s.text(x + 31, y + 25, actor, 12 if mobile else 13, COLORS["text"], 650)
    if not mobile:
        s.text(x + 219, y + 25, "· 8 分钟", 11, COLORS["muted"])
    label = "需要你确认" if needs_user else "暂不需要你"
    pw = 82 if needs_user else 78
    pill(s, x + w - pw - 38, y + 8, label, COLORS["warning_soft"] if needs_user else COLORS["soft"], COLORS["warning"] if needs_user else COLORS["secondary"], pw, 24, COLORS["warning"] if needs_user else "none")
    icon_chevron(s, x + w - 18, y + 20, "down")
    return h


def progress_summary(s: SVG, x, y, w):
    h = 84
    s.rect(x, y, w, h, COLORS["canvas"], stroke=COLORS["border"], sw=1)
    s.circle(x + 18, y + 22, 4, COLORS["success"])
    s.text(x + 31, y + 27, "烁烁正在完成桌面与移动端视觉稿", 13, COLORS["text"], 700)
    s.text(x + 281, y + 27, "· 8 分钟", 11, COLORS["muted"])
    pill(s, x + w - 116, y + 10, "暂不需要你", COLORS["soft"], COLORS["secondary"], 82, 24)
    icon_chevron(s, x + w - 18, y + 22, "up")
    s.line(x + 16, y + 41, x + w - 16, y + 41, COLORS["border"])
    s.text(x + 18, y + 65, "最近：状态不确定时的展示规则已确认", 11, COLORS["secondary"], 550)
    s.text(x + 268, y + 65, "下一步：确认视觉开合", 11, COLORS["secondary"], 550)
    s.text(x + w - 18, y + 65, "查看完整进展 ›", 11, COLORS["accent"], 700, "end")
    return h


def message_bubble(s: SVG, x, y, w, who="cat", color=None, title="", lines=None, user=False):
    lines = lines or []
    if user:
        bw = min(w * .62, 520)
        bx = x + w - bw - 26
        bh = 46 + max(0, len(lines) - 1) * 18
        s.rect(bx, y, bw, bh, COLORS["soft"], rx=16, stroke=COLORS["border"])
        s.text(bx + 18, y + 20, title, 11, COLORS["muted"], 600)
        for i, line in enumerate(lines):
            s.text(bx + 18, y + 39 + i * 18, line, 12, COLORS["text"], 450)
        return bh
    color = color or COLORS["siamese"]
    avatar(s, x + 25, y + 22, color, who[0], 14)
    s.text(x + 48, y + 17, title, 11, color, 700)
    bw = min(w * .78, 660)
    bh = 56 + max(0, len(lines) - 1) * 20
    s.rect(x + 48, y + 25, bw, bh, COLORS["canvas"], rx=15, stroke=COLORS["border"], filt="shadow")
    s.rect(x + 48, y + 25, 3, bh, color, rx=1.5)
    for i, line in enumerate(lines):
        s.text(x + 66, y + 49 + i * 20, line, 12, COLORS["text"] if i == 0 else COLORS["secondary"], 500 if i else 600)
    return bh + 25


def chat_messages(s: SVG, x, y, w, h, compact=False):
    s.rect(x, y, w, h, COLORS["chat"])
    top = y + 22
    message_bubble(s, x + 10, top, w - 20, user=True, title="你 · 20:47", lines=["这样会不会把聊天消息折得太小，或者支持打开收起？"])
    top += 82
    top += message_bubble(
        s, x + 16, top, w - 32, who="宪", color=COLORS["ragdoll"], title="布偶猫 / 宪宪 · 20:48",
        lines=["会。最稳的是聊天优先、三级开合：", "收起 40px，摘要最多 84px，完整历史只在右侧 Workspace。"]
    )
    top += 16
    top += message_bubble(
        s, x + 16, top, w - 32, who="烁", color=COLORS["siamese"], title="暹罗猫 / 烁烁 · 20:49",
            lines=["我会让“需要你”只高亮，不强制展开。", "关闭完整进展后，聊天宽度立即恢复。"]
    )
    if not compact and top < y + h - 110:
        top += 16
        message_bubble(
            s, x + 16, top, w - 32, who="砚", color=COLORS["maine"], title="缅因猫 / 砚砚 · 20:50",
            lines=["信息不足时只显示“暂时无法确认”，不会拿陈旧任务冒充执行。"]
        )


def chat_input(s: SVG, x, y, w, mobile=False):
    h = 94 if not mobile else 82
    s.rect(x, y, w, h, COLORS["chat"])
    s.line(x, y, x + w, y, COLORS["border"])
    margin = 14 if mobile else 22
    s.rect(x + margin, y + 12, w - margin * 2, h - 24, COLORS["canvas"], rx=16, stroke=COLORS["border2"], filt="shadow")
    s.text(x + margin + 18, y + 40, "输入消息，或 @召唤某只猫…", 12, COLORS["muted"])
    s.circle(x + margin + 18, y + h - 26, 8, "none", COLORS["muted"], 1.2)
    s.line(x + margin + 15, y + h - 26, x + margin + 21, y + h - 26, COLORS["muted"], 1.2)
    s.rect(x + w - margin - 58, y + h - 42, 44, 28, COLORS["accent"], rx=14)
    s.text(x + w - margin - 36, y + h - 23, "发送", 11, COLORS["white"], 700, "middle")


def mobile_messages(s: SVG, x, y, w, h):
    s.rect(x, y, w, h, COLORS["chat"])
    top = y + 22
    message_bubble(
        s, x + 8, top, w - 16, user=True, title="你 · 20:47",
        lines=["会不会把聊天区折得太小？", "能否支持打开和收起？"]
    )
    top += 100
    top += message_bubble(
        s, x + 8, top, w - 16, who="宪", color=COLORS["ragdoll"], title="宪宪 · 20:48",
        lines=["最稳的是聊天优先、三级开合：", "收起 40px，摘要不超过 84px。", "完整历史只在右侧打开。"]
    )
    top += 14
    message_bubble(
        s, x + 8, top, w - 16, who="烁", color=COLORS["siamese"], title="烁烁 · 20:49",
        lines=["“需要你”只高亮，不强制展开。", "关闭后聊天宽度立即恢复。"]
    )


def desktop_chat(state: str, filename: str):
    W, H = 1440, 900
    s = SVG(W, H, f"桌面会话页 · {state}")
    activity_rail(s, H, active="chat")
    thread_sidebar(s, 52, 240, H)
    chat_x = 292
    panel_w = 420 if state == "完整进展打开态" else 0
    chat_w = W - chat_x - panel_w
    header_h = chat_header(s, chat_x, chat_w)
    if state == "摘要态":
        progress_h = progress_summary(s, chat_x, header_h, chat_w)
    else:
        progress_h = progress_collapsed(s, chat_x, header_h, chat_w, needs_user=False)
    input_h = 94
    chat_messages(s, chat_x, header_h + progress_h, chat_w, H - header_h - progress_h - input_h, compact=panel_w > 0)
    chat_input(s, chat_x, H - input_h, chat_w)
    if panel_w:
        timeline_panel(s, W - panel_w, 0, panel_w, H)
    truth_label(s)
    (OUT / filename).write_text(s.finish(), encoding="utf-8")


def timeline_event(s: SVG, x, y, w, time, actor_name, color, headline, detail=None, next_step=None, last=False):
    avatar(s, x + 20, y + 20, color, actor_name[0], 11)
    if not last:
        s.line(x + 20, y + 33, x + 20, y + 102, COLORS["border2"], 1.4)
    s.text(x + 42, y + 16, actor_name, 11, color, 700)
    s.text(x + w - 8, y + 16, time, 10, COLORS["muted"], 500, "end")
    s.text(x + 42, y + 38, headline, 12, COLORS["text"], 700)
    if detail:
        s.text(x + 42, y + 59, detail, 11, COLORS["secondary"])
    if next_step:
        s.rect(x + 42, y + 70, w - 50, 27, COLORS["soft"], rx=8)
        s.text(x + 52, y + 88, f"下一步：{next_step}", 10, COLORS["secondary"], 550)
    s.text(x + 42, y + 113, "查看依据 ›", 10, COLORS["accent"], 700)


def timeline_panel(s: SVG, x, y, w, h):
    s.rect(x, y, w, h, COLORS["sidebar"])
    s.line(x, 0, x, h, COLORS["border2"])
    s.rect(x, 0, w, 44, COLORS["sidebar"])
    s.circle(x + 18, 22, 4, COLORS["info"])
    s.text(x + 30, 27, "状态与会话", 12, COLORS["text"], 700)
    s.rect(x + w - 42, 6, 32, 32, COLORS["soft"], rx=10)
    s.rect(x + w - 33, 13, 14, 16, "none", rx=3, stroke=COLORS["secondary"], sw=1.2)
    s.line(x + w - 25, 13, x + w - 25, 29, COLORS["secondary"], 1.1)
    s.line(x + 12, 44, x + w, 44, COLORS["border"])
    s.text(x + 34, 75, "进展", 12, COLORS["accent"], 750, "middle")
    s.text(x + 112, 75, "运行详情", 12, COLORS["muted"], 600, "middle")
    s.line(x + 10, 85, x + 64, 85, COLORS["accent"], 2.5)
    s.line(x + 10, 86, x + w - 10, 86, COLORS["border"])
    s.rect(x + 14, 100, w - 28, 78, COLORS["canvas"], rx=12, stroke=COLORS["border"])
    s.circle(x + 30, 123, 4, COLORS["success"])
    s.text(x + 43, 128, "烁烁正在完成视觉交付", 12, COLORS["text"], 700)
    s.text(x + 43, 150, "最近活动 8 分钟 · 暂不需要你", 10, COLORS["muted"])
    pill(s, x + w - 102, 116, "查看本轮计划", COLORS["soft"], COLORS["accent"], 76, 24)
    s.text(x + 16, 207, "今天", 11, COLORS["muted"], 700)
    timeline_event(s, x + 16, 222, w - 32, "20:49", "烁烁", COLORS["siamese"], "完成三级开合视觉方案", "桌面、全局与移动端画布已生成", "请确认视觉取舍")
    timeline_event(s, x + 16, 354, w - 32, "20:32", "宪宪", COLORS["ragdoll"], "确认聊天优先的开合规则", "收起 40px，摘要不超过 88px", None)
    s.text(x + 16, 494, "更早", 11, COLORS["muted"], 700)
    timeline_event(s, x + 16, 508, w - 32, "19:52", "砚砚", COLORS["maine"], "确认状态不确定时的展示规则", "无法证明执行状态时只显示暂时无法确认", None, last=True)
    s.rect(x + 14, h - 110, w - 28, 76, COLORS["soft"], rx=12)
    s.text(x + 28, h - 82, "有 3 项待办", 11, COLORS["secondary"], 650)
    s.text(x + w - 28, h - 82, "查看毛线球 ›", 10, COLORS["accent"], 700, "end")
    s.text(x + 28, h - 56, "下一步只来自最新进展回执", 10, COLORS["muted"])


def recent_card(s: SVG, x, y, w, title, status, status_color, actor, summary, next_step, needs=False):
    fill = COLORS["warning_soft"] if needs else COLORS["canvas"]
    stroke = COLORS["warning"] if needs else COLORS["border"]
    s.rect(x, y, w, 112, fill, rx=14, stroke=stroke, filt="shadow")
    s.text(x + 18, y + 25, title, 13, COLORS["text"], 750)
    sw = pill(s, x + w - 104, y + 12, status, COLORS["warning_soft"] if needs else COLORS["soft"], status_color, 86, 24, stroke if needs else "none")
    s.circle(x + 20, y + 51, 4, status_color)
    s.text(x + 32, y + 55, actor, 11, COLORS["secondary"], 650)
    s.text(x + 18, y + 79, summary, 11, COLORS["secondary"])
    s.text(x + 18, y + 101, f"下一步：{next_step}", 10, COLORS["muted"])
    s.text(x + w - 18, y + 101, "进入会话 ›", 10, COLORS["accent"], 700, "end")


def global_recent():
    W, H = 1440, 900
    s = SVG(W, H, "全局近况页")
    activity_rail(s, H, active="recent")
    x = 52
    s.rect(x, 0, W - x, H, COLORS["chat"])
    s.rect(x, 0, W - x, 72, COLORS["chat"])
    s.line(x, 72, W, 72, COLORS["border"])
    s.text(x + 40, 33, "近况", 22, COLORS["text"], 800)
    s.text(x + 40, 55, "你近期推进的会话 · 与会话内信息保持一致", 11, COLORS["muted"])
    pill(s, W - 170, 22, "最近更新", COLORS["soft"], COLORS["secondary"], 108, 28)
    content_x = x + 74
    col_w = (W - content_x - 74 - 24) / 2
    s.text(content_x, 112, "需要你", 13, COLORS["warning"], 750)
    pill(s, content_x + 62, 95, "1", COLORS["warning_soft"], COLORS["warning"], 28, 22)
    recent_card(s, content_x, 130, col_w, "会话进度视图设计", "需要你", COLORS["warning"], "烁烁已完成视觉稿", "需要确认三级开合是否保留", "确认视觉方案", True)
    s.text(content_x, 278, "正在推进", 13, COLORS["success"], 750)
    pill(s, content_x + 76, 261, "1", COLORS["success_soft"], COLORS["success"], 28, 22)
    recent_card(s, content_x, 296, col_w, "Runtime Harness 深入学习", "推进中", COLORS["success"], "宪宪正在对比 Codex 与 Pi", "已明确 session 接续的共同维度", "补齐 Pi runtime 证据")
    s.text(content_x, 438, "状态待确认", 13, COLORS["info"], 750)
    pill(s, content_x + 90, 421, "2", COLORS["info_soft"], COLORS["info"], 28, 22)
    recent_card(s, content_x, 456, col_w, "Agent eval 方法论", "状态确认中", COLORS["info"], "运行信号不完整", "暂不能确认是否仍在执行", "等待状态恢复")
    recent_card(s, content_x, 580, col_w, "Prompt 注入校验", "暂时无法确认", COLORS["muted"], "当前状态读取失败", "没有使用陈旧任务推断运行状态", "稍后重新读取")
    right_x = content_x + col_w + 24
    s.text(right_x, 112, "等待外部", 13, COLORS["info"], 750)
    pill(s, right_x + 76, 95, "1", COLORS["info_soft"], COLORS["info"], 28, 22)
    recent_card(s, right_x, 130, col_w, "Pi session 接续机制", "等待外部", COLORS["info"], "等待 runtime 行为样本", "已提交可复现采样请求", "收到样本后继续对比")
    s.text(right_x, 278, "最近有进展", 13, COLORS["secondary"], 750)
    pill(s, right_x + 90, 261, "2", COLORS["soft"], COLORS["secondary"], 28, 22)
    recent_card(s, right_x, 296, col_w, "Codex 开源范围调研", "最近更新", COLORS["secondary"], "当前无人执行 · 12 分钟前", "已厘清不同运行方式的边界", "尚未明确")
    recent_card(s, right_x, 420, col_w, "Session Continuity 笔记", "最近更新", COLORS["secondary"], "当前无人执行 · 昨天", "沉淀了三种 session 恢复路径", "复核跨 runtime 适用性")
    s.rect(right_x, 578, col_w, 92, COLORS["soft"], rx=14, stroke=COLORS["border"])
    s.text(right_x + 20, 608, "近况为空时", 12, COLORS["text"], 700)
    s.text(right_x + 20, 633, "只有当前事实或进展回执的会话才会出现。", 11, COLORS["muted"])
    s.text(right_x + 20, 656, "不会因为刚有消息或陈旧待办自动入选。", 10, COLORS["muted"])
    truth_label(s)
    (OUT / "04-global-recent.svg").write_text(s.finish(), encoding="utf-8")


def narrow_desktop_overlay():
    W, H = 1024, 768
    s = SVG(W, H, "窄桌面会话页 · 覆盖式完整进展")
    s.items.append(
        "<metadata>responsive-rule: residual-chat-width&lt;640 =&gt; overlay-drawer; "
        "close restores original chat width and scroll position</metadata>"
    )
    activity_rail(s, H, active="chat")
    thread_sidebar(s, 52, 240, H)
    chat_x = 292
    chat_w = W - chat_x  # 732px — overlay must not reflow this width.
    header_h = chat_header(s, chat_x, chat_w)
    progress_h = progress_collapsed(s, chat_x, header_h, chat_w, needs_user=False)
    input_h = 94
    chat_messages(s, chat_x, header_h + progress_h, chat_w, H - header_h - progress_h - input_h, compact=True)
    chat_input(s, chat_x, H - input_h, chat_w)

    # The scrim and drawer are composited over the unchanged 732px chat canvas.
    s.rect(chat_x, 0, chat_w, H, "#302823", opacity=.16)
    drawer_w = 420
    drawer_x = W - drawer_w
    timeline_panel(s, drawer_x, 0, drawer_w, H)
    s.rect(chat_x + 14, 116, 282, 34, "#3f3732", rx=17, opacity=.88)
    s.text(chat_x + 155, 138, "体验 Gate：聊天布局仍为 732px（未重排）", 10, COLORS["white"], 650, "middle")
    s.rect(drawer_x + 16, H - 146, drawer_w - 32, 30, COLORS["info_soft"], rx=10, stroke=COLORS["info"])
    s.text(drawer_x + 30, H - 126, "覆盖式抽屉 · 关闭后恢复原聊天宽度和滚动位置", 10, COLORS["info"], 700)
    truth_label(s)
    (OUT / "07-narrow-desktop-overlay.svg").write_text(s.finish(), encoding="utf-8")


def mobile_chat():
    W, H = 390, 844
    s = SVG(W, H, "移动端会话页 · 收起态")
    activity_rail(s, H, active="chat", width=48)
    x, w = 48, W - 48
    header_h = chat_header(s, x, w, mobile=True)
    progress_h = progress_collapsed(s, x, header_h, w, needs_user=True, mobile=True)
    input_h = 82
    mobile_messages(s, x, header_h + progress_h, w, H - header_h - progress_h - input_h)
    chat_input(s, x, H - input_h, w, mobile=True)
    truth_label(s, mobile=True)
    (OUT / "05-mobile-collapsed.svg").write_text(s.finish(), encoding="utf-8")


def mobile_drawer():
    W, H = 390, 844
    s = SVG(W, H, "移动端会话进展 · 全屏抽屉")
    s.rect(0, 0, W, H, COLORS["sidebar"])
    s.rect(0, 0, W, 58, COLORS["canvas"])
    s.line(0, 58, W, 58, COLORS["border"])
    s.text(18, 36, "会话进展", 17, COLORS["text"], 800)
    s.text(W - 20, 36, "关闭", 12, COLORS["accent"], 700, "end")
    s.text(18, 83, "会话：会话进度视图设计", 11, COLORS["muted"], 600)
    s.rect(14, 98, W - 28, 98, COLORS["warning_soft"], rx=14, stroke=COLORS["warning"])
    s.text(28, 124, "需要你确认", 11, COLORS["warning"], 750)
    s.text(28, 150, "烁烁已完成三级开合视觉稿", 13, COLORS["text"], 750)
    s.text(28, 175, "去处理：确认这套布局是否进入实现", 11, COLORS["secondary"])
    pill(s, W - 108, 112, "去处理", COLORS["warning"], COLORS["white"], 76, 28)
    s.text(18, 226, "今天", 11, COLORS["muted"], 700)
    timeline_event(s, 14, 240, W - 28, "20:49", "烁烁", COLORS["siamese"], "完成三级开合视觉方案", "桌面与移动端画布已生成", "确认视觉取舍")
    timeline_event(s, 14, 372, W - 28, "20:32", "宪宪", COLORS["ragdoll"], "确认聊天优先规则", "收起 40px，摘要不超过 88px", None)
    s.text(18, 516, "更早", 11, COLORS["muted"], 700)
    timeline_event(s, 14, 530, W - 28, "19:52", "砚砚", COLORS["maine"], "确认状态不确定时的展示规则", "无法证明执行状态时只显示暂时无法确认", None, last=True)
    s.rect(14, H - 94, W - 28, 62, COLORS["soft"], rx=12)
    s.text(28, H - 68, "有 3 项待办", 11, COLORS["secondary"], 700)
    s.text(W - 28, H - 68, "查看毛线球 ›", 10, COLORS["accent"], 700, "end")
    s.text(28, H - 46, "关闭后回到原聊天滚动位置", 10, COLORS["muted"])
    truth_label(s, mobile=True)
    (OUT / "06-mobile-full-progress.svg").write_text(s.finish(), encoding="utf-8")


def html_gallery():
    views = [
        ("desktop-collapsed", "桌面 · 收起态", "01-desktop-collapsed.svg", "1440 × 900"),
        ("desktop-summary", "桌面 · 摘要态", "02-desktop-summary.svg", "1440 × 900"),
        ("desktop-full", "桌面 · 完整进展", "03-desktop-full-progress.svg", "1440 × 900"),
        ("global", "全局 · 近况", "04-global-recent.svg", "1440 × 900"),
        ("mobile-collapsed", "移动 · 收起态", "05-mobile-collapsed.svg", "390 × 844"),
        ("mobile-full", "移动 · 全屏进展", "06-mobile-full-progress.svg", "390 × 844"),
        ("narrow-overlay", "窄桌面 · 覆盖进展", "07-narrow-desktop-overlay.svg", "1024 × 768"),
    ]
    buttons = "\n".join(
        f'<button data-view="{vid}" onclick="showView(\'{vid}\')">{label}</button>' for vid, label, _, _ in views
    )
    frames = "\n".join(
        f'<section id="{vid}" class="view"><header><strong>{label}</strong><span>{size}</span></header>'
        f'<div class="canvas"><img src="{file}" alt="{label}"></div></section>'
        for vid, label, file, size in views
    )
    data = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Thread Progress Visual Gate</title><style>
:root{{--bg:#201b18;--panel:#2b2420;--text:#fff8f1;--muted:#b9aaa0;--accent:#e0a17d}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font-family:Inter,"PingFang SC",sans-serif}}
.shell{{min-height:100vh;display:grid;grid-template-columns:260px minmax(0,1fr)}}
aside{{position:sticky;top:0;height:100vh;padding:24px 18px;background:var(--panel);border-right:1px solid #463a33}}
h1{{font-size:18px;margin:0 0 8px}}p{{font-size:12px;line-height:1.6;color:var(--muted);margin:0 0 20px}}
nav{{display:grid;gap:8px}}button{{border:1px solid #4c3f38;background:#352d28;color:var(--text);padding:10px 12px;border-radius:10px;text-align:left;cursor:pointer}}
button:hover,button.active{{border-color:var(--accent);background:#4a352b}}main{{padding:20px;min-width:0}}
.truth{{display:inline-flex;padding:5px 9px;border-radius:999px;background:#4a352b;color:#ffd7c2;font-size:11px;margin-bottom:14px}}
.view{{display:none}}.view.active{{display:block}}.view>header{{display:flex;justify-content:space-between;align-items:center;margin:0 0 12px;color:var(--muted);font-size:12px}}
.view>header strong{{color:var(--text);font-size:14px}}.canvas{{background:#15110f;border:1px solid #453a34;border-radius:14px;overflow:auto;padding:12px;box-shadow:0 16px 40px #0008}}
.canvas img{{display:block;max-width:none;width:100%;height:auto;background:#fff}}
@media(max-width:760px){{.shell{{grid-template-columns:1fr}}aside{{position:relative;height:auto}}nav{{grid-template-columns:repeat(2,minmax(0,1fr))}}main{{padding:12px}}}}
</style></head><body><div class="shell"><aside><h1>Thread Progress Visual Gate</h1>
<p>product_experience_gate × internal_product_gate<br>点击切换同一产品壳的六个确定性状态。</p><nav>{buttons}</nav></aside>
<main><span class="truth">功能原型 · 演示数据 · 未连接后端</span>{frames}</main></div>
<script>function showView(id){{document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===id));document.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.view===id));location.hash=id}}
const first=location.hash.slice(1)||'desktop-collapsed';showView(document.getElementById(first)?first:'desktop-collapsed');</script></body></html>'''
    (OUT / "index.html").write_text(data, encoding="utf-8")


def main():
    desktop_chat("收起态", "01-desktop-collapsed.svg")
    desktop_chat("摘要态", "02-desktop-summary.svg")
    desktop_chat("完整进展打开态", "03-desktop-full-progress.svg")
    global_recent()
    mobile_chat()
    mobile_drawer()
    narrow_desktop_overlay()
    html_gallery()
    print("Rendered seven SVG canvases and index.html")


if __name__ == "__main__":
    main()
