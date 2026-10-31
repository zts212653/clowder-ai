"""Pure recovery policy; no process control or installation side effects."""

import math

COOLDOWN_SECONDS = 24 * 60 * 60
MAX_SAMPLE_GAP_SECONDS = 180


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def identity(row):
    return {"pid": row.get("pid"), "startedAt": row.get("startedAt")}


def critical(row):
    # Same multi-signal thresholds as scripts/lib/fseventsd-pressure.mjs.
    # Automation additionally refuses missing CPU/identity observations.
    if not isinstance(row, dict):
        return False
    if not isinstance(row.get("pid"), int) or isinstance(row["pid"], bool) or row["pid"] <= 1:
        return False
    if not isinstance(row.get("startedAt"), str) or not row["startedAt"]:
        return False
    if not all(finite_number(row.get(key)) for key in ["rssKb", "cpuPercent", "totalMemoryKb"]):
        return False
    rss, total, cpu = row["rssKb"], row["totalMemoryKb"], row["cpuPercent"]
    free = row.get("memoryFreePercent")
    if total <= 0 or rss < 0 or cpu < 0:
        return False
    if rss <= min(4 * 1024 * 1024, math.floor(total * .1)):
        return False
    return (rss >= total * .2 or (rss >= total * .1 and cpu >= 50)
            or (finite_number(free) and 0 <= free <= 10))


def evaluate(observation, state, now):
    updated = dict(state)
    streak = updated.pop("streak", {})
    result = {"action": "observe", "state": updated}
    if not finite_number(now) or not critical(observation):
        return result
    attempted = state.get("lastAttemptAt")
    if attempted is not None and (not finite_number(attempted) or now - attempted < COOLDOWN_SECONDS):
        return result
    same_target = streak.get("identity") == identity(observation)
    gap = now - streak.get("lastAt", now)
    if same_target and 30 <= gap <= MAX_SAMPLE_GAP_SECONDS:
        streak = {**streak, "lastAt": now, "count": streak["count"] + 1}
    else:
        streak = {"identity": identity(observation), "firstAt": now, "lastAt": now, "count": 1}
    updated["streak"] = streak
    if streak["count"] >= 3 and now - streak["firstAt"] >= 120:
        result["action"] = "capture"
    return result
