"""CLI for initializing runtime data into ~/.jiuwenclaw.

无论是通过 pip/whl 安装，还是在源码目录里直接运行：
- 运行本脚本会先询问语言偏好（zh/en），写入 config 的 preferred_language，
  并将对应语言的 PRINCIPLE/TONE/HEARTBEAT 模板复制为 ~/.jiuwenclaw/agent/home/ 下 PRINCIPLE.md、TONE.md、HEARTBEAT.md；
- 同时复制 config.yaml、.env.template、agent 其余模板等到 ~/.jiuwenclaw。
"""

from __future__ import annotations

import logging
import sys

from jiuwenclaw.utils import init_user_workspace


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    target = init_user_workspace(overwrite=True)
    if target == "cancelled":
        sys.exit(1)
    print(f"[jiuwenclaw-init] initialized: {target}")


if __name__ == "__main__":
    main()
