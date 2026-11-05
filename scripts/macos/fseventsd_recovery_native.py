"""Native macOS observation and bounded tools. No user-supplied commands/PIDs."""

import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import time

from fseventsd_recovery_policy import critical, identity

BINARY = ("/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/"
          "FSEvents.framework/Versions/A/Support/fseventsd")
ENVIRONMENT = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C", "HOME": "/var/empty"}
FILE_LIMIT = 16 * 1024 ** 2


def command(arguments):
    return subprocess.check_output(arguments, env=ENVIRONMENT, timeout=10, text=True, stderr=subprocess.DEVNULL)


def parse_processes(text):
    candidates = []
    for line in text.splitlines():
        fields = line.split(None, 10)
        if len(fields) != 11 or Path(fields[10]).name != "fseventsd":
            continue
        if fields[10] != BINARY or fields[1:3] != ["1", "0"]:
            raise RuntimeError("fseventsd path, parent or owner mismatch")
        candidates.append({"pid": int(fields[0]), "startedAt": " ".join(fields[3:8]),
                           "rssKb": int(fields[8]), "cpuPercent": float(fields[9])})
    if len(candidates) != 1:
        raise RuntimeError("expected exactly one root/launchd-owned fseventsd")
    return candidates[0]


def bounded_tool(arguments, output_path, timeout=20):
    def limit_output():
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_FSIZE, (FILE_LIMIT, FILE_LIMIT))
    descriptor = os.open(str(output_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        child = subprocess.Popen(arguments, env=ENVIRONMENT, stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
                                 preexec_fn=limit_output)
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Only this helper's diagnostic child group; never the daemon.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            code = "timeout"
        except BaseException:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            raise
        output.flush()
        os.fsync(output.fileno())
    return {"tool": Path(arguments[0]).name, "exitCode": code, "output": output_path.name}


class NativeHost:
    def observe(self):
        row = parse_processes(command(["/bin/ps", "-axo", "pid=,ppid=,uid=,lstart=,rss=,%cpu=,comm="]))
        row["totalMemoryKb"] = int(command(["/usr/sbin/sysctl", "-n", "hw.memsize"]).strip()) // 1024
        try:
            pressure = command(["/usr/bin/memory_pressure", "-Q"])
            match = re.search(r"System-wide memory free percentage:\s*(\d+)%", pressure)
            row["memoryFreePercent"] = int(match.group(1)) if match else None
        except (OSError, subprocess.SubprocessError):
            row["memoryFreePercent"] = None
        return row

    def capture(self, expected, directory):
        directory = Path(directory)
        pid = str(expected["pid"])
        tools = [
            ["/usr/bin/vmmap", "-summary", pid],
            ["/usr/bin/heap", "-s", "-z", "-showSizes", "-noContent", pid],
            ["/usr/bin/sample", pid, "3", "1", "-file", str(directory / "sample.txt")],
        ]
        results = []
        for arguments in tools:
            if identity(self.observe()) != identity(expected):
                break
            output = directory / (Path(arguments[0]).name + ".stdout.txt")
            try:
                results.append(bounded_tool(arguments, output))
            except OSError as error:
                results.append({"tool": Path(arguments[0]).name, "exitCode": "unavailable", "error": str(error)})
        # No full memgraph of a multi-GiB process: its size/cost is not safely
        # bounded by RSS. The optional healthy baseline remains a separate tool.
        return results

    def terminate(self, expected):
        if os.geteuid() != 0:
            raise RuntimeError("native recovery requires root")
        current = self.observe()
        if identity(current) != identity(expected) or not critical(current):
            return False
        os.kill(current["pid"], signal.SIGTERM)
        return True

    def wait_replacement(self, previous):
        deadline = time.monotonic() + 30
        candidate = None
        samples = 0
        while time.monotonic() < deadline:
            time.sleep(1)
            try:
                current = self.observe()
            except (RuntimeError, OSError, subprocess.SubprocessError):
                candidate, samples = None, 0
                continue
            if identity(current) != identity(previous):
                samples = samples + 1 if identity(current) == candidate else 1
                candidate = identity(current)
                if samples >= 3:
                    return {**current, "healthy": current["rssKb"] < 512 * 1024 and not critical(current),
                            "consecutiveReplacementSamples": samples}
            else:
                candidate, samples = None, 0
        return {"healthy": False, "reason": "replacement_not_observed_within_budget"}
