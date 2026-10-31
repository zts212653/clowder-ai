"""Unprivileged PID 1 for the disposable public-test process namespace.

Only wait for children the kernel assigns to this init. Never infer exit from
procfs, signal arbitrary PIDs, or change the shard's cleanup/lease predicates.
"""

import ctypes
import os
import signal
import subprocess
import sys


def verify_domain():
    if sys.platform != "linux" or os.getpid() != 1 or os.getuid() == 0:
        raise RuntimeError("requires unprivileged namespace PID 1")
    death_signal = ctypes.c_int()
    if ctypes.CDLL(None, use_errno=True).prctl(2, ctypes.byref(death_signal), 0, 0, 0) != 0:
        raise RuntimeError("cannot verify parent-death signal")
    if death_signal.value != signal.SIGKILL:
        raise RuntimeError("namespace init requires SIGKILL parent-death signal")


def reap_until_command_exit(command_pid):
    while True:
        # Includes adopted orphans, unlike a runtime waiting only for the
        # child handles it created. waitpid reaps only fully exited children;
        # a zombie leader with live threads cannot satisfy this wait.
        pid, status = os.waitpid(-1, 0)
        if pid == command_pid:
            code = os.waitstatus_to_exitcode(status)
            return code if code >= 0 else 128 - code


def main():
    verify_domain()
    if len(sys.argv) < 2:
        raise RuntimeError("missing shard command")
    # Explicit handlers let ancestor-namespace cancellation terminate PID 1.
    # Exiting init makes the kernel kill the whole private domain, including
    # detached descendants. No host/group-zero signal authority is needed.
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda received, _frame: os._exit(128 + received))
    command = subprocess.Popen(sys.argv[1:], start_new_session=True)
    # Leave stdin/stdout/stderr, environment and cwd intact. Python's isolated
    # mode prevents PYTHONPATH/site hooks from changing the supervisor itself.
    os._exit(reap_until_command_exit(command.pid))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No raw exception: command arguments/environment can contain secrets.
        print("public-test namespace init failed", file=sys.stderr, flush=True)
        os._exit(1)
