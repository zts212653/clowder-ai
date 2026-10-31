"""Fixed-purpose, opt-in macOS fseventsd recovery. Observe is the CLI default."""

import json
import os
from pathlib import Path
import signal
import sys
import syslog
import time

HELPER_ROOT = Path("/Library/PrivilegedHelperTools/cat-cafe-fseventsd")


def require_installed_bundle():
    directory = Path(__file__).resolve().parent
    if os.geteuid() != 0 or directory.parent != HELPER_ROOT:
        raise RuntimeError("recovery requires the installed root-owned bundle")
    for path in [*directory.parents, directory, *directory.iterdir()]:
        info = path.lstat()
        if path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("unsafe installed helper ownership or permissions")


# Isolated Python deliberately omits the script directory. Recovery validates
# its fixed root-owned bundle before allowing sibling module imports.
if __name__ == "__main__" and sys.argv[1:] in [["--recover"], ["--baseline"]]:
    require_installed_bundle()
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.dont_write_bytecode = True
from fseventsd_recovery_policy import critical, evaluate, identity


def capture_baseline(native, store, now):
    observation = native.observe()
    if observation["rssKb"] > 512 * 1024 or critical(observation):
        raise RuntimeError("installation requires a healthy small daemon for the native capability baseline")
    incident = store.new_incident(now)
    store.report(incident, "before.json", observation)
    captured = native.capture(observation, incident)
    store.report(incident, "capture.json", captured)
    if identity(native.observe()) != identity(observation):
        raise RuntimeError("baseline target changed; automatic recovery not enabled")
    if not any(item.get("exitCode") == 0 for item in captured):
        raise RuntimeError("native capture capability unavailable; automatic recovery not enabled")
    result = {"action": "baseline", "incident": str(incident), "nativeCaptureVerified": True}
    store.report(incident, "outcome.json", result)
    return result


def run_once(native, store, now):
    previous = store.read()
    observation = native.observe()
    decision = evaluate(observation, previous, now)
    if decision["action"] != "capture":
        store.save(decision["state"])
        return {"action": "observe", "observation": observation}

    incident = store.new_incident(now)
    # Consume the cooldown before any native collection or signal. A crash never
    # turns an unfinished attempt into a signal/restart loop on the next tick.
    state = {"lastAttemptAt": now, "lastTarget": identity(observation)}
    store.save(state)
    store.report(incident, "before.json", observation)
    captured = native.capture(observation, incident)
    store.report(incident, "capture.json", captured)
    current = native.observe()
    if identity(current) != identity(observation):
        outcome = {"action": "cancelled", "reason": "target_changed"}
    elif not any(item.get("exitCode") == 0 for item in captured):
        outcome = {"action": "blocked", "reason": "native_capture_failed"}
    elif not critical(current):
        outcome = {"action": "cancelled", "reason": "pressure_recovered"}
    else:
        store.report(incident, "signal-intent.json", {"target": identity(current), "signal": "TERM"})
        # Native adapter rechecks identity AND pressure immediately before kill.
        if not native.terminate(current):
            outcome = {"action": "cancelled", "reason": "target_or_pressure_changed"}
        else:
            replacement = native.wait_replacement(current)
            outcome = {"action": "term_sent", "replacement": replacement}
    store.report(incident, "outcome.json", outcome)
    return {**outcome, "incident": str(incident)}


def main():
    os.umask(0o077)
    from fseventsd_recovery_native import NativeHost
    if sys.argv[1:] in [[], ["--observe"]]:
        print(json.dumps({"action": "observe", "observation": NativeHost().observe()}))
        return
    if sys.argv[1:] not in [["--recover"], ["--baseline"]]:
        raise RuntimeError("usage: fseventsd_recovery.py [--observe | --baseline | --recover]")
    require_installed_bundle()
    def interrupted(_signum, _frame):
        raise SystemExit("recovery helper stopped; attempt/cooldown preserved")
    signal.signal(signal.SIGTERM, interrupted)
    from fseventsd_recovery_store import RecoveryStore
    with RecoveryStore() as store:
        operation = capture_baseline if sys.argv[1:] == ["--baseline"] else run_once
        result = operation(NativeHost(), store, time.time())
    # Healthy ticks do not create logs or rewrite state files.
    if result["action"] != "observe":
        syslog.syslog("cat-cafe-fseventsd " + json.dumps(result))
        print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        if sys.argv[1:] == ["--recover"]:
            syslog.syslog(syslog.LOG_ERR, "cat-cafe-fseventsd blocked: " + str(error))
        print(json.dumps({"action": "blocked", "error": str(error)}), file=sys.stderr)
        sys.exit(1)
