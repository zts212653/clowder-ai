#!/usr/bin/env python3

from __future__ import annotations

import asyncio
import time
import unittest

from embed_runtime_policy import (
    AdmissionError,
    EmbeddingAdmissionController,
    MemoryBudgetExceeded,
    MemoryMetricUnavailable,
    MlxMemoryEnvelope,
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
    def test_applies_allocator_limits_and_uses_os_footprint_delta_as_hard_gate(
        self,
    ) -> None:
        mib = 1024 * 1024
        footprints = iter([100 * mib, 100 * mib + 2 * mib])
        mlx = FakeMlx()
        envelope = MlxMemoryEnvelope(
            max_model_mem_mb=1,
            mlx=mlx,
            footprint_reader=lambda: next(footprints),
        )

        envelope.configure_before_model_load()
        envelope.capture_baseline()

        self.assertEqual(mlx.memory_limits, [mib])
        self.assertEqual(mlx.cache_limits, [0])
        with self.assertRaises(MemoryBudgetExceeded) as exceeded:
            envelope.assert_within_budget(requested_max_model_mem_mb=8)
        self.assertEqual(exceeded.exception.budget_bytes, mib)
        self.assertEqual(exceeded.exception.footprint_delta_bytes, 2 * mib)
        self.assertTrue(envelope.snapshot()["memory_budget_exceeded"])

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
