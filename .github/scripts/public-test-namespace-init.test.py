"""Portable real-child checks; Linux adoption remains a launcher integration test."""

import importlib.util
import os
from pathlib import Path
import signal
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("namespace_init", Path(__file__).with_name("public-test-namespace-init.py"))
init = importlib.util.module_from_spec(spec)
spec.loader.exec_module(init)


class ReaperTest(unittest.TestCase):
    def run_children(self, command_signal=None):
        read_fd, write_fd = os.pipe()
        command_pid = os.fork()
        if command_pid == 0:
            os.close(write_fd)
            signal.alarm(5)
            os.read(read_fd, 1)
            if command_signal:
                os.kill(os.getpid(), command_signal)
            os._exit(37)
        other_pid = os.fork()
        if other_pid == 0:
            os._exit(9)
        try:
            raw_waitpid = os.waitpid
            reaped = []

            def observe_waitpid(pid, flags):
                actual_pid, status = raw_waitpid(pid, flags)
                reaped.append(actual_pid)
                if actual_pid == other_pid:
                    os.write(write_fd, b"x")
                return actual_pid, status

            with patch.object(init.os, "waitpid", side_effect=observe_waitpid):
                result = init.reap_until_command_exit(command_pid)
            self.assertEqual(reaped, [other_pid, command_pid])
            return result
        finally:
            os.close(read_fd)
            os.close(write_fd)
            for pid in (command_pid, other_pid):
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass

    def test_command_exit_code_is_preserved(self):
        self.assertEqual(self.run_children(), 37)

    def test_command_signal_is_failure(self):
        self.assertEqual(self.run_children(signal.SIGTERM), 143)

    def test_refuses_non_namespace_execution(self):
        with self.assertRaises(RuntimeError):
            init.verify_domain()


if __name__ == "__main__":
    unittest.main()
