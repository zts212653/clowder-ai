"""将外部 cron 任务 JSON（如 OpenClaw 嵌套 schedule/payload/delivery）转为内部扁平 dict。"""

from __future__ import annotations

from typing import Any


def convert_cron_job_dict_to_flat(data: dict[str, Any]) -> dict[str, Any]:
    """
    若为嵌套格式（含 schedule.kind=cron），则转为 CronJob.from_dict 可用的扁平字段；
    已是扁平且含 cron_expr + timezone 时原样返回。

    不处理 state.nextRunAtMs 等运行态字段（调度仍由 cron 表达式计算）。
    """
    if not isinstance(data, dict):
        return {}
    cron_expr = str(data.get("cron_expr") or "").strip()
    timezone = str(data.get("timezone") or "").strip()
    if cron_expr and timezone:
        return data

    sched = data.get("schedule")
    if not isinstance(sched, dict):
        return data
    if str(sched.get("kind") or "").strip().lower() != "cron":
        return data

    expr = str(sched.get("expr") or "").strip()
    tz = str(sched.get("tz") or "").strip()

    wake_mode = str(data.get("wakeMode") or "").strip().lower()
    wake_offset_seconds = 0 if wake_mode == "now" else 300

    desc = str(data.get("description") or "")
    payload = data.get("payload")
    if isinstance(payload, dict) and str(payload.get("kind") or "") == "systemEvent":
        pt = str(payload.get("text") or "").strip()
        if pt:
            desc = pt

    targets = ""
    delivery = data.get("delivery")
    if isinstance(delivery, dict):
        targets = str(delivery.get("channel") or "").strip()
    if not targets:
        targets = str(data.get("targets") or "").strip()

    created_at: float | None = None
    updated_at: float | None = None
    ca = data.get("created_at")
    ua = data.get("updated_at")
    if isinstance(ca, (int, float)):
        created_at = float(ca)
    elif "createdAtMs" in data:
        cam = data.get("createdAtMs")
        if isinstance(cam, (int, float)):
            created_at = float(cam) / 1000.0
    if isinstance(ua, (int, float)):
        updated_at = float(ua)
    elif "updatedAtMs" in data:
        uam = data.get("updatedAtMs")
        if isinstance(uam, (int, float)):
            updated_at = float(uam) / 1000.0

    return {
        "id": str(data.get("id") or "").strip(),
        "name": str(data.get("name") or "").strip(),
        "enabled": bool(data.get("enabled", False)),
        "cron_expr": expr,
        "timezone": tz,
        "wake_offset_seconds": wake_offset_seconds,
        "description": desc,
        "targets": targets,
        "created_at": created_at,
        "updated_at": updated_at,
    }
