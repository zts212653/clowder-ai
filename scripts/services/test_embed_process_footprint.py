#!/usr/bin/env python3

import ctypes
import unittest
from unittest.mock import Mock, patch

import embed_process_footprint as footprint
from embed_runtime_policy import MemoryMetricUnavailable, MlxMemoryEnvelope


class ProcessFootprintTest(unittest.TestCase):
    def test_reads_physical_footprint_instead_of_resident_size(self) -> None:
        def read(pid, flavor, buffer):
            self.assertEqual(pid, 4321)
            self.assertEqual(flavor, 0)
            info = ctypes.cast(buffer, ctypes.POINTER(footprint._RusageInfoV0)).contents
            info.ri_resident_size = 9_000_000
            info.ri_phys_footprint = 1_234_567
            return 0

        with patch.object(footprint.sys, "platform", "darwin"), patch.object(
            footprint, "_load_proc_pid_rusage", return_value=read
        ):
            self.assertEqual(footprint.read_process_footprint_bytes(4321), 1_234_567)

    def test_failed_kernel_read_discards_even_a_populated_buffer(self) -> None:
        def denied(_pid, _flavor, buffer):
            info = ctypes.cast(buffer, ctypes.POINTER(footprint._RusageInfoV0)).contents
            info.ri_phys_footprint = 999
            ctypes.set_errno(1)
            return -1

        with patch.object(footprint.sys, "platform", "darwin"), patch.object(
            footprint, "_load_proc_pid_rusage", return_value=denied
        ), self.assertLogs(footprint.log, level="WARNING") as logs:
            self.assertIsNone(footprint.read_process_footprint_bytes())
        self.assertIn("status=-1 errno=1", logs.output[0])

    def test_unavailable_library_or_symbol_stays_unavailable(self) -> None:
        for error in [OSError("library unavailable"), AttributeError("missing symbol")]:
            with self.subTest(error=type(error).__name__), patch.object(
                footprint.sys, "platform", "darwin"
            ), patch.object(
                footprint, "_load_proc_pid_rusage", side_effect=error
            ), self.assertLogs(footprint.log, level="WARNING") as logs:
                self.assertIsNone(footprint.read_process_footprint_bytes())
            self.assertIn(type(error).__name__, logs.output[0])

    def test_non_macos_does_not_load_a_darwin_library(self) -> None:
        with patch.object(footprint.sys, "platform", "linux"), patch.object(
            footprint, "_load_proc_pid_rusage"
        ) as load:
            self.assertIsNone(footprint.read_process_footprint_bytes())
            load.assert_not_called()

    def test_native_read_failure_still_blocks_required_inference(self) -> None:
        mlx = Mock()
        mlx.get_active_memory.return_value = 300
        mlx.get_cache_memory.return_value = 0
        mlx.get_peak_memory.return_value = 500

        def read(_pid, _flavor, buffer):
            info = ctypes.cast(buffer, ctypes.POINTER(footprint._RusageInfoV0)).contents
            info.ri_phys_footprint = 1_000_000
            return 0

        with patch.object(footprint.sys, "platform", "darwin"), patch.object(
            footprint, "_load_proc_pid_rusage", return_value=read
        ) as load:
            envelope = MlxMemoryEnvelope(max_model_mem_mb=800, mlx=mlx)
            envelope.capture_baseline()
            load.return_value = lambda *_: -1
            with self.assertLogs(footprint.log, level="WARNING"), self.assertRaises(
                MemoryMetricUnavailable
            ):
                envelope.assert_within_budget()
            self.assertFalse(envelope.snapshot()["os_footprint_available"])
            self.assertFalse(envelope.snapshot()["memory_budget_exceeded"])


if __name__ == "__main__":
    unittest.main()
