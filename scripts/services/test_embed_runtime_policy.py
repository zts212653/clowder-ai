#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import itertools
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import embed_runtime_policy
from embed_runtime_policy import (
    AdmissionError,
    EmbeddingAdmissionController,
    MemoryBudgetExceeded,
    MemoryMetricUnavailable,
    MlxMemoryEnvelope,
    read_process_footprint_bytes,
)


async def wait_until(predicate, timeout_seconds: float = 1.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("condition did not become true before timeout")


class EmbeddingAdmissionControllerTest(unittest.IsolatedAsyncioTestCase):
    async def test_simultaneous_arrivals_cannot_overbook_capacity(self) -> None:
        controller = EmbeddingAdmissionController(
            max_queue_depth=1,
            default_timeout_ms=500,
            max_timeout_ms=1_000,
            disconnect_poll_ms=5,
        )
        start = asyncio.Event()
        active_release = asyncio.Event()
        entered: list[int] = []
        rejected: list[int] = []

        async def contender(index: int) -> None:
            await start.wait()
            try:
                async with controller.admit(deadline_ms=None, is_disconnected=None):
                    entered.append(index)
                    if len(entered) == 1:
                        await active_release.wait()
            except AdmissionError as error:
                self.assertEqual(error.code, "queue_full")
                rejected.append(index)

        tasks = [asyncio.create_task(contender(index)) for index in range(6)]
        start.set()
        await wait_until(
            lambda: controller.snapshot()["in_flight"] == 1
            and controller.snapshot()["queue_depth"] == 1
            and len(rejected) == 4
        )
        active_release.set()
        await asyncio.gather(*tasks)

        self.assertEqual(len(entered), 2)
        self.assertEqual(len(rejected), 4)
        self.assertEqual(controller.snapshot()["queue_depth"], 0)
        self.assertEqual(controller.snapshot()["in_flight"], 0)

    async def test_capacity_is_bounded_while_one_request_is_active(self) -> None:
        controller = EmbeddingAdmissionController(
            max_queue_depth=1,
            default_timeout_ms=500,
            max_timeout_ms=1_000,
            disconnect_poll_ms=5,
        )
        active_release = asyncio.Event()

        async def hold_active() -> None:
            async with controller.admit(deadline_ms=None, is_disconnected=None):
                await active_release.wait()

        async def wait_for_slot() -> None:
            async with controller.admit(deadline_ms=None, is_disconnected=None):
                return

        active = asyncio.create_task(hold_active())
        await wait_until(lambda: controller.snapshot()["in_flight"] == 1)
        queued = asyncio.create_task(wait_for_slot())
        await wait_until(lambda: controller.snapshot()["queue_depth"] == 1)

        with self.assertRaises(AdmissionError) as rejected:
            async with controller.admit(deadline_ms=None, is_disconnected=None):
                self.fail("over-capacity request must not acquire the encoder")
        self.assertEqual(rejected.exception.status_code, 429)
        self.assertEqual(rejected.exception.code, "queue_full")

        active_release.set()
        await active
        await queued
        self.assertEqual(controller.snapshot()["in_flight"], 0)
        self.assertEqual(controller.snapshot()["queue_depth"], 0)
        self.assertEqual(controller.snapshot()["rejected_count"], 1)

    async def test_expired_waiter_never_enters_encode_section(self) -> None:
        controller = EmbeddingAdmissionController(
            max_queue_depth=2,
            default_timeout_ms=500,
            max_timeout_ms=1_000,
            disconnect_poll_ms=5,
        )
        active_release = asyncio.Event()
        entered = False

        async def hold_active() -> None:
            async with controller.admit(deadline_ms=None, is_disconnected=None):
                await active_release.wait()

        async def expired_waiter() -> None:
            nonlocal entered
            async with controller.admit(
                deadline_ms=int(time.time() * 1_000) + 25,
                is_disconnected=None,
            ):
                entered = True

        active = asyncio.create_task(hold_active())
        await wait_until(lambda: controller.snapshot()["in_flight"] == 1)
        with self.assertRaises(AdmissionError) as expired:
            await expired_waiter()
        self.assertEqual(expired.exception.status_code, 408)
        self.assertEqual(expired.exception.code, "deadline_expired")
        self.assertFalse(entered)
        self.assertEqual(controller.snapshot()["expired_count"], 1)

        active_release.set()
        await active

    async def test_disconnected_waiter_never_enters_encode_section(self) -> None:
        controller = EmbeddingAdmissionController(
            max_queue_depth=2,
            default_timeout_ms=500,
            max_timeout_ms=1_000,
            disconnect_poll_ms=5,
        )
        active_release = asyncio.Event()
        disconnected = False
        entered = False

        async def hold_active() -> None:
            async with controller.admit(deadline_ms=None, is_disconnected=None):
                await active_release.wait()

        async def is_disconnected() -> bool:
            return disconnected

        async def disconnected_waiter() -> None:
            nonlocal entered
            async with controller.admit(
                deadline_ms=None, is_disconnected=is_disconnected
            ):
                entered = True

        active = asyncio.create_task(hold_active())
        await wait_until(lambda: controller.snapshot()["in_flight"] == 1)
        waiter = asyncio.create_task(disconnected_waiter())
        await wait_until(lambda: controller.snapshot()["queue_depth"] == 1)
        disconnected = True

        with self.assertRaises(AdmissionError) as rejected:
            await waiter
        self.assertEqual(rejected.exception.status_code, 499)
        self.assertEqual(rejected.exception.code, "client_disconnected")
        self.assertFalse(entered)
        self.assertEqual(controller.snapshot()["disconnected_count"], 1)

        active_release.set()
        await active

    async def test_exception_inside_admitted_work_releases_the_encoder(self) -> None:
        controller = EmbeddingAdmissionController(
            max_queue_depth=1,
            default_timeout_ms=500,
            max_timeout_ms=1_000,
            disconnect_poll_ms=5,
        )

        with self.assertRaisesRegex(RuntimeError, "encode failed"):
            async with controller.admit(deadline_ms=None, is_disconnected=None):
                raise RuntimeError("encode failed")

        async with controller.admit(deadline_ms=None, is_disconnected=None):
            pass
        self.assertEqual(controller.snapshot()["in_flight"], 0)
        self.assertEqual(controller.snapshot()["queue_depth"], 0)

    async def test_admitted_work_can_recheck_the_deadline_it_was_admitted_with(
        self,
    ) -> None:
        # Work that waits after admission (the memory guard settling) must be
        # able to ask again before it allocates for the request.
        controller = EmbeddingAdmissionController(
            max_queue_depth=0,
            default_timeout_ms=500,
            max_timeout_ms=1_000,
            disconnect_poll_ms=5,
        )
        allocated = False

        with self.assertRaises(AdmissionError) as expired:
            async with controller.admit(
                deadline_ms=int(time.time() * 1_000) + 25,
                is_disconnected=None,
            ) as assert_still_wanted:
                await assert_still_wanted()
                await asyncio.sleep(0.06)
                await assert_still_wanted()
                allocated = True
        self.assertEqual(expired.exception.status_code, 408)
        self.assertEqual(expired.exception.code, "deadline_expired")
        self.assertFalse(allocated)
        self.assertEqual(controller.snapshot()["expired_count"], 1)
        self.assertEqual(controller.snapshot()["in_flight"], 0)

    async def test_admitted_work_can_recheck_that_the_client_is_still_connected(
        self,
    ) -> None:
        controller = EmbeddingAdmissionController(
            max_queue_depth=0,
            default_timeout_ms=500,
            max_timeout_ms=1_000,
            disconnect_poll_ms=5,
        )
        disconnected = False
        allocated = False

        async def is_disconnected() -> bool:
            return disconnected

        with self.assertRaises(AdmissionError) as rejected:
            async with controller.admit(
                deadline_ms=None, is_disconnected=is_disconnected
            ) as assert_still_wanted:
                await assert_still_wanted()
                disconnected = True
                await assert_still_wanted()
                allocated = True
        self.assertEqual(rejected.exception.status_code, 499)
        self.assertEqual(rejected.exception.code, "client_disconnected")
        self.assertFalse(allocated)
        self.assertEqual(controller.snapshot()["disconnected_count"], 1)
        self.assertEqual(controller.snapshot()["in_flight"], 0)

    async def test_cancelled_waiter_releases_its_queue_reservation(self) -> None:
        controller = EmbeddingAdmissionController(
            max_queue_depth=1,
            default_timeout_ms=500,
            max_timeout_ms=1_000,
            disconnect_poll_ms=5,
        )
        active_release = asyncio.Event()

        async def hold_active() -> None:
            async with controller.admit(deadline_ms=None, is_disconnected=None):
                await active_release.wait()

        async def wait_for_slot() -> None:
            async with controller.admit(deadline_ms=None, is_disconnected=None):
                pass

        active = asyncio.create_task(hold_active())
        await wait_until(lambda: controller.snapshot()["in_flight"] == 1)
        queued = asyncio.create_task(wait_for_slot())
        await wait_until(lambda: controller.snapshot()["queue_depth"] == 1)
        queued.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await queued
        self.assertEqual(controller.snapshot()["queue_depth"], 0)

        active_release.set()
        await active


class FakeClock:
    """Deterministic stand-in for the policy module's ``time``.

    Settle polls advance the wall clock too, so a request's own deadline can
    pass while the guard is waiting -- without the test sleeping for real.
    """

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []
        self._wall_start = time.time()

    @property
    def elapsed(self) -> float:
        return self.now - 1000.0

    def monotonic(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds

    def time(self) -> float:
        return self._wall_start + self.elapsed


class FakeMlx:
    def __init__(self) -> None:
        self.memory_limits: list[int] = []
        self.cache_limits: list[int] = []
        self.clear_count = 0

    def set_memory_limit(self, value: int) -> int:
        self.memory_limits.append(value)
        return 0

    def set_cache_limit(self, value: int) -> int:
        self.cache_limits.append(value)
        return 0

    def clear_cache(self) -> None:
        self.clear_count += 1

    def get_active_memory(self) -> int:
        return 300

    def get_cache_memory(self) -> int:
        return 40

    def get_peak_memory(self) -> int:
        return 500


class MlxMemoryEnvelopeTest(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "darwin", "macOS process ledger")
    def test_self_footprint_survives_unavailable_sampling_command(self) -> None:
        with patch(
            "subprocess.run",
            side_effect=subprocess.TimeoutExpired("/usr/bin/footprint", 2),
        ):
            footprint = read_process_footprint_bytes()
        self.assertIsInstance(footprint, int)
        self.assertGreater(footprint, 0)

    def test_applies_allocator_limits_and_uses_os_footprint_delta_as_hard_gate(
        self,
    ) -> None:
        mib = 1024 * 1024
        # Baseline, then a footprint that never comes back down: retained memory.
        footprints = itertools.chain([100 * mib], itertools.repeat(100 * mib + 2 * mib))
        mlx = FakeMlx()
        clock = FakeClock()
        envelope = MlxMemoryEnvelope(
            max_model_mem_mb=1,
            mlx=mlx,
            footprint_reader=lambda: next(footprints),
        )

        envelope.configure_before_model_load()
        envelope.capture_baseline()

        self.assertEqual(mlx.memory_limits, [mib])
        self.assertEqual(mlx.cache_limits, [0])
        with patch.object(embed_runtime_policy, "time", clock):
            with self.assertRaises(MemoryBudgetExceeded) as exceeded:
                envelope.assert_within_budget(requested_max_model_mem_mb=8)
        self.assertTrue(clock.sleeps, "a first over-budget sample must be re-read before the sidecar is killed")
        self.assertEqual(exceeded.exception.budget_bytes, mib)
        self.assertEqual(exceeded.exception.footprint_delta_bytes, 2 * mib)
        self.assertEqual(exceeded.exception.first_observed_bytes, 2 * mib)
        self.assertEqual(
            exceeded.exception.settle_ms,
            round(embed_runtime_policy.MEMORY_SETTLE_WINDOW_SECONDS * 1000),
            "retained memory is declared only after the whole settle window",
        )
        self.assertTrue(envelope.snapshot()["memory_budget_exceeded"])

    def test_reading_the_os_reclaims_within_the_settle_window_is_not_retained_memory(
        self,
    ) -> None:
        # Synthetic trajectory, not a recording. The first sample borrows the
        # size logged on 2026-11-12 (3134 MiB over baseline); that it then falls
        # back is this test's assumption. Whether the production readings would
        # have fallen back is unknown -- the old guard exited before re-reading.
        mib = 1024 * 1024
        base = 1000 * mib
        footprints = iter([base, base + 3134 * mib, base + 900 * mib, base + 40 * mib])
        clock = FakeClock()
        envelope = MlxMemoryEnvelope(
            max_model_mem_mb=800,
            mlx=FakeMlx(),
            footprint_reader=lambda: next(footprints),
        )
        envelope.capture_baseline()

        with patch.object(embed_runtime_policy, "time", clock):
            settled = envelope.assert_within_budget()

        self.assertIsNotNone(settled, "a reclaimed overshoot must be reported, not hidden")
        self.assertEqual(settled.budget_bytes, 800 * mib)
        self.assertEqual(settled.first.observed_bytes, 3134 * mib)
        self.assertEqual(settled.settled.observed_bytes, 40 * mib)
        self.assertEqual(settled.settle_ms, 50)
        snapshot = envelope.snapshot()
        self.assertFalse(snapshot["memory_budget_exceeded"])
        self.assertEqual(snapshot["transient_overshoot_count"], 1)
        self.assertEqual(snapshot["transient_overshoot_max_bytes"], 3134 * mib)

    def test_reading_within_budget_is_a_single_sample_with_no_wait(self) -> None:
        footprints = iter([1234, 1234])
        clock = FakeClock()
        envelope = MlxMemoryEnvelope(
            max_model_mem_mb=8,
            mlx=FakeMlx(),
            footprint_reader=lambda: next(footprints),
        )
        envelope.capture_baseline()
        with patch.object(embed_runtime_policy, "time", clock):
            self.assertIsNone(envelope.assert_within_budget())
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(envelope.snapshot()["transient_overshoot_count"], 0)

    def test_metric_lost_while_settling_still_fails_closed(self) -> None:
        mib = 1024 * 1024
        footprints = iter([100 * mib, 100 * mib + 2 * mib, None])
        envelope = MlxMemoryEnvelope(
            max_model_mem_mb=1,
            mlx=FakeMlx(),
            footprint_reader=lambda: next(footprints),
            require_footprint=True,
        )
        envelope.capture_baseline()
        with patch.object(embed_runtime_policy, "time", FakeClock()):
            with self.assertRaises(MemoryMetricUnavailable):
                envelope.assert_within_budget()

    def test_health_metrics_keep_allocator_and_os_scopes_distinct(self) -> None:
        mlx = FakeMlx()
        envelope = MlxMemoryEnvelope(
            max_model_mem_mb=8,
            mlx=mlx,
            footprint_reader=lambda: 1234,
        )
        envelope.configure_before_model_load()
        envelope.capture_baseline()
        snapshot = envelope.snapshot(refresh_footprint=True)

        self.assertEqual(
            snapshot["memory_metric_scope"], "mlx_allocator_and_os_process_footprint"
        )
        self.assertEqual(snapshot["mlx_active_memory_bytes"], 300)
        self.assertEqual(snapshot["mlx_cache_memory_bytes"], 40)
        self.assertEqual(snapshot["mlx_peak_memory_bytes"], 500)
        self.assertEqual(snapshot["os_footprint_bytes"], 1234)
        self.assertNotEqual(
            snapshot["mlx_peak_memory_bytes"], snapshot["os_footprint_bytes"]
        )

    def test_required_os_footprint_must_exist_at_startup(self) -> None:
        envelope = MlxMemoryEnvelope(
            max_model_mem_mb=8,
            mlx=FakeMlx(),
            footprint_reader=lambda: None,
            require_footprint=True,
        )
        with self.assertRaises(MemoryMetricUnavailable):
            envelope.capture_baseline()

    def test_required_os_footprint_must_remain_available(self) -> None:
        footprints = iter([1234, None])
        envelope = MlxMemoryEnvelope(
            max_model_mem_mb=8,
            mlx=FakeMlx(),
            footprint_reader=lambda: next(footprints),
            require_footprint=True,
        )
        envelope.capture_baseline()
        with self.assertRaises(MemoryMetricUnavailable):
            envelope.assert_within_budget()


if __name__ == "__main__":
    unittest.main()
