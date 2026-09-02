#!/usr/bin/env python3
"""Deterministic contract checks for the Thread Progress visual prototype."""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent

EXPECTED = {
    "01-desktop-collapsed.svg": (1440, 900, ["暂不需要你", "烁烁正在完成 UI 视觉稿"]),
    "02-desktop-summary.svg": (1440, 900, ["最近：状态不确定时的展示规则已确认", "查看完整进展"]),
    "03-desktop-full-progress.svg": (1440, 900, ["状态与会话", "进展", "运行详情", "查看毛线球"]),
    "04-global-recent.svg": (
        1440,
        900,
        ["近况", "需要你", "正在推进", "状态待确认", "状态确认中", "暂时无法确认", "等待外部", "最近有进展"],
    ),
    "05-mobile-collapsed.svg": (390, 844, ["需要你确认", "烁烁正在做视觉稿"]),
    "06-mobile-full-progress.svg": (390, 844, ["会话进展", "关闭", "关闭后回到原聊天滚动位置"]),
    "07-narrow-desktop-overlay.svg": (
        1024,
        768,
        ["覆盖式抽屉", "聊天布局仍为 732px", "关闭后恢复原聊天宽度和滚动位置"],
    ),
}

FORBIDDEN_UI_TERMS = [
    "ThreadBrief",
    "LiveInvocation",
    "TaskProgress",
    "fail-closed",
    "verified",
    "attested",
    "sourceKey",
    "catId",
    "invocationId",
    "commit",
    "tool",
]

FORBIDDEN_UI_PATTERNS = [re.compile(r"\bF\d{2,4}\b")]


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    sys.exit(1)


def main() -> None:
    for name, (width, height, markers) in EXPECTED.items():
        path = ROOT / name
        if not path.exists():
            fail(f"missing canvas: {name}")
        body = path.read_text(encoding="utf-8")
        head = re.search(r'<svg[^>]*width="(\d+)"[^>]*height="(\d+)"[^>]*viewBox="0 0 (\d+) (\d+)"', body)
        if not head:
            fail(f"missing fixed canvas metadata: {name}")
        actual = tuple(map(int, head.groups()))
        if actual != (width, height, width, height):
            fail(f"wrong canvas size for {name}: {actual}")
        if "功能原型 · 演示数据" not in body:
            fail(f"missing truth label: {name}")
        for marker in markers:
            if marker not in body:
                fail(f"missing marker {marker!r} in {name}")
        for term in FORBIDDEN_UI_TERMS:
            if term in body:
                fail(f"internal term {term!r} leaked into {name}")
        for pattern in FORBIDDEN_UI_PATTERNS:
            if pattern.search(body):
                fail(f"internal pattern {pattern.pattern!r} leaked into {name}")

    collapsed = (ROOT / "01-desktop-collapsed.svg").read_text(encoding="utf-8")
    summary = (ROOT / "02-desktop-summary.svg").read_text(encoding="utf-8")
    if 'height="40"' not in collapsed:
        fail("desktop collapsed state does not contain the 40px progress bar")
    if 'height="84"' not in summary:
        fail("desktop summary state does not contain the 84px summary")

    narrow = (ROOT / "07-narrow-desktop-overlay.svg").read_text(encoding="utf-8")
    if "residual-chat-width&lt;640 =&gt; overlay-drawer" not in narrow:
        fail("narrow desktop canvas is missing the 640px dock/overlay metadata contract")

    contract = (ROOT / "DEMO-CONTRACT.md").read_text(encoding="utf-8")
    if "dockedResidualChatWidth >= 640px" not in contract:
        fail("Demo Contract is missing the dynamic 640px dock threshold")
    if "不改变 Chat 的 flex-basis、内容宽度或 scroll position" not in contract:
        fail("Demo Contract is missing overlay close/recovery semantics")
    for marker in ["scrim 拦截底层点击", "焦点限制在 drawer 内", "Escape"]:
        if marker not in contract:
            fail(f"Demo Contract is missing overlay interaction guard: {marker}")

    index = (ROOT / "index.html").read_text(encoding="utf-8")
    for name in EXPECTED:
        if name not in index:
            fail(f"gallery does not reference {name}")
    if "未连接后端" not in index:
        fail("gallery truth boundary is missing")

    print("PASS: seven fixed canvases, truth labels, human-language guards, 40px/84px states, 640px overlay rule, and gallery links")


if __name__ == "__main__":
    main()
