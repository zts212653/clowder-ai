"""Runtime admission and memory policy for the embedding sidecar.

This module intentionally uses only the Python standard library so its state
machine can be tested without importing FastAPI, NumPy, or MLX.
"""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Awaitable, Callable, Protocol


MIB = 1024 * 1024


class AdmissionError(RuntimeError):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class EmbeddingAdmissionController:
    """Own the single encoder slot and its finite waiter set."""

    def __init__(
        self,
        *,
        max_queue_depth: int,
        default_timeout_ms: int,
        max_timeout_ms: int,
        disconnect_poll_ms: int = 50,
    ) -> None:
        if max_queue_depth < 0:
            raise ValueError("max_queue_depth must be non-negative")
        if default_timeout_ms <= 0 or max_timeout_ms <= 0:
            raise ValueError("timeouts must be positive")
        if disconnect_poll_ms <= 0:
            raise ValueError("disconnect_poll_ms must be positive")
        self._encoder_lock = asyncio.Lock()
        self._max_queue_depth = max_queue_depth
        self._default_timeout_ms = min(default_timeout_ms, max_timeout_ms)
        self._max_timeout_ms = max_timeout_ms
        self._disconnect_poll_seconds = disconnect_poll_ms / 1_000
        self._waiting_count = 0
        self._in_flight = 0
        self._rejected_count = 0
        self._expired_count = 0
        self._disconnected_count = 0

    def snapshot(self) -> dict[str, int]:
        queue_depth = max(0, self._waiting_count - (0 if self._in_flight else 1))
        return {
            "max_queue_depth": self._max_queue_depth,
            "queue_depth": queue_depth,
            "in_flight": self._in_flight,
            "rejected_count": self._rejected_count,
            "expired_count": self._expired_count,
            "disconnected_count": self._disconnected_count,
        }

    def _effective_deadline_seconds(self, deadline_ms: int | None) -> float:
        now = time.time()
        maximum = now + self._max_timeout_ms / 1_000
        if deadline_ms is None:
            return now + self._default_timeout_ms / 1_000
        return min(deadline_ms / 1_000, maximum)

    async def _client_disconnected(
        self, callback: Callable[[], Awaitable[bool]] | None
    ) -> bool:
        if callback is None:
            return False
        try:
            return await callback()
        except Exception:
            # A disconnect probe is advisory. Its own failure must not invent a
            # client disconnect or bypass the independently enforced deadline.
            return False

    @asynccontextmanager
    async def admit(
        self,
        *,
        deadline_ms: int | None,
        is_disconnected: Callable[[], Awaitable[bool]] | None,
    ) -> AsyncIterator[None]:
        deadline_seconds = self._effective_deadline_seconds(deadline_ms)
        if deadline_seconds <= time.time():
            self._expired_count += 1
            raise AdmissionError(
                408, "deadline_expired", "embedding request deadline already expired"
            )
        if await self._client_disconnected(is_disconnected):
            self._disconnected_count += 1
            raise AdmissionError(
                499,
                "client_disconnected",
                "embedding client disconnected before admission",
            )

        # Reserve one of (active slot + bounded waiter slots) before the first
        # await. This event-loop-atomic reservation closes the race where two
        # simultaneous requests both observe an unlocked asyncio.Lock.
        if self._in_flight + self._waiting_count >= self._max_queue_depth + 1:
            self._rejected_count += 1
            raise AdmissionError(429, "queue_full", "embedding admission queue is full")
        self._waiting_count += 1
        waiting = True

        acquire_task = asyncio.create_task(self._encoder_lock.acquire())
        acquired = False
        try:
            while not acquire_task.done():
                remaining_seconds = deadline_seconds - time.time()
                if remaining_seconds <= 0:
                    self._expired_count += 1
                    raise AdmissionError(
                        408,
                        "deadline_expired",
                        "embedding request expired while queued",
                    )
                if await self._client_disconnected(is_disconnected):
                    self._disconnected_count += 1
                    raise AdmissionError(
                        499,
                        "client_disconnected",
                        "embedding client disconnected while queued",
                    )
                await asyncio.wait(
                    {acquire_task},
                    timeout=min(self._disconnect_poll_seconds, remaining_seconds),
                )

            await acquire_task
            acquired = True
            self._waiting_count -= 1
            waiting = False
            self._in_flight = 1

            if deadline_seconds <= time.time():
                self._expired_count += 1
                raise AdmissionError(
                    408, "deadline_expired", "embedding request expired before encode"
                )
            if await self._client_disconnected(is_disconnected):
                self._disconnected_count += 1
                raise AdmissionError(
                    499,
                    "client_disconnected",
                    "embedding client disconnected before encode",
                )

            yield
        finally:
            if waiting:
                self._waiting_count -= 1
            if not acquire_task.done():
                acquire_task.cancel()
                try:
                    await acquire_task
                except asyncio.CancelledError:
                    pass
            elif not acquired:
                # The lock task may have completed between the last loop check
                # and an exception/cancellation. Claim its result so the slot
                # cannot remain locked without an owner.
                try:
                    await acquire_task
                    acquired = True
                except asyncio.CancelledError:
                    pass
            if acquired:
                self._in_flight = 0
                self._encoder_lock.release()


class MlxMemoryApi(Protocol):
    def set_memory_limit(self, value: int) -> int: ...

    def set_cache_limit(self, value: int) -> int: ...

    def clear_cache(self) -> None: ...

    def get_active_memory(self) -> int: ...

    def get_cache_memory(self) -> int: ...

    def get_peak_memory(self) -> int: ...


def read_process_footprint_bytes(pid: int | None = None) -> int | None:
    """Return macOS phys_footprint without confusing it with RSS/MLX counters."""

    if sys.platform != "darwin":
        return None
    try:
        result = subprocess.run(
            [
                "/usr/bin/footprint",
                "--pid",
                str(pid or os.getpid()),
                "--format",
                "bytes",
                "--noCategories",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return None
    match = re.search(
        r"^\s*phys_footprint:\s+(\d+)\s+B\s*$", result.stdout, re.MULTILINE
    )
    return int(match.group(1)) if match else None


class MemoryBudgetExceeded(RuntimeError):
    def __init__(
        self, *, budget_bytes: int, footprint_delta_bytes: int, observed_bytes: int
    ) -> None:
        super().__init__(
            f"embedding memory budget exceeded: observed={observed_bytes} "
            f"delta={footprint_delta_bytes} budget={budget_bytes}"
        )
        self.budget_bytes = budget_bytes
        self.footprint_delta_bytes = footprint_delta_bytes
        self.observed_bytes = observed_bytes


class MemoryMetricUnavailable(RuntimeError):
    pass


class MlxMemoryEnvelope:
    """Apply the MLX soft limits and enforce a separate process-footprint gate."""

    def __init__(
        self,
        *,
        max_model_mem_mb: int,
        mlx: MlxMemoryApi,
        footprint_reader: Callable[[], int | None] = read_process_footprint_bytes,
        require_footprint: bool | None = None,
    ) -> None:
        if max_model_mem_mb <= 0:
            raise ValueError("max_model_mem_mb must be positive")
        self._max_model_mem_mb = max_model_mem_mb
        self._max_model_mem_bytes = max_model_mem_mb * MIB
        self._mlx = mlx
        self._footprint_reader = footprint_reader
        self._require_footprint = (
            sys.platform == "darwin" if require_footprint is None else require_footprint
        )
        self._baseline_footprint_bytes: int | None = None
        self._last_footprint_bytes: int | None = None
        self._memory_budget_exceeded = False

    def configure_before_model_load(self) -> None:
        self._mlx.set_memory_limit(self._max_model_mem_bytes)
        self._mlx.set_cache_limit(0)

    def capture_baseline(self) -> None:
        self._last_footprint_bytes = self._footprint_reader()
        if self._require_footprint and self._last_footprint_bytes is None:
            raise MemoryMetricUnavailable(
                "macOS process footprint is unavailable; refusing unprotected MLX inference"
            )
        self._baseline_footprint_bytes = self._last_footprint_bytes

    def _effective_budget_bytes(self, requested_max_model_mem_mb: int | None) -> int:
        if requested_max_model_mem_mb is None or requested_max_model_mem_mb <= 0:
            return self._max_model_mem_bytes
        return min(requested_max_model_mem_mb * MIB, self._max_model_mem_bytes)

    def assert_within_budget(
        self, requested_max_model_mem_mb: int | None = None
    ) -> None:
        self._mlx.clear_cache()
        footprint = self._footprint_reader()
        self._last_footprint_bytes = footprint
        if self._require_footprint and footprint is None:
            raise MemoryMetricUnavailable(
                "macOS process footprint became unavailable; stopping MLX inference"
            )
        allocator_bytes = int(self._mlx.get_active_memory()) + int(
            self._mlx.get_cache_memory()
        )
        baseline = self._baseline_footprint_bytes
        footprint_delta = (
            max(0, footprint - baseline)
            if footprint is not None and baseline is not None
            else 0
        )
        observed_bytes = max(allocator_bytes, footprint_delta)
        budget_bytes = self._effective_budget_bytes(requested_max_model_mem_mb)
        if observed_bytes > budget_bytes:
            self._memory_budget_exceeded = True
            raise MemoryBudgetExceeded(
                budget_bytes=budget_bytes,
                footprint_delta_bytes=footprint_delta,
                observed_bytes=observed_bytes,
            )

    def snapshot(
        self, refresh_footprint: bool = False
    ) -> dict[str, int | str | bool | None]:
        if refresh_footprint:
            self._last_footprint_bytes = self._footprint_reader()
        footprint_delta = (
            max(0, self._last_footprint_bytes - self._baseline_footprint_bytes)
            if self._last_footprint_bytes is not None
            and self._baseline_footprint_bytes is not None
            else None
        )
        metric_scope = (
            "mlx_allocator_and_os_process_footprint"
            if self._last_footprint_bytes is not None
            else "mlx_allocator_only"
        )
        return {
            "memory_metric_scope": metric_scope,
            "max_model_mem_mb": self._max_model_mem_mb,
            "mlx_active_memory_bytes": int(self._mlx.get_active_memory()),
            "mlx_cache_memory_bytes": int(self._mlx.get_cache_memory()),
            "mlx_peak_memory_bytes": int(self._mlx.get_peak_memory()),
            "os_footprint_bytes": self._last_footprint_bytes,
            "baseline_os_footprint_bytes": self._baseline_footprint_bytes,
            "os_footprint_delta_bytes": footprint_delta,
            "os_footprint_required": self._require_footprint,
            "os_footprint_available": self._last_footprint_bytes is not None,
            "memory_budget_exceeded": self._memory_budget_exceeded,
        }
