"""Single-thread ownership for ML runtimes with thread-affine resources."""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor


class DedicatedModelWorker:
    """Run model load and all inference on one long-lived OS thread."""

    def __init__(self, thread_name: str):
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=thread_name)
        self._state_lock = threading.Lock()
        self._closed = False

    @property
    def closed(self) -> bool:
        with self._state_lock:
            return self._closed

    def _submit(self, operation, *args):
        with self._state_lock:
            if self._closed:
                raise RuntimeError("Dedicated model worker has been shut down")
            return self._executor.submit(operation, *args)

    def run_sync(self, operation, *args):
        return self._submit(operation, *args).result()

    async def run(self, operation, *args):
        return await asyncio.wrap_future(self._submit(operation, *args))

    def shutdown(self):
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
        self._executor.shutdown(wait=True, cancel_futures=True)
