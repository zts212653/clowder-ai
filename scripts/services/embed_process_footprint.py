"""Read the macOS physical-footprint ledger without a sampling subprocess."""

from __future__ import annotations

import ctypes
import logging
import os
import sys
from functools import lru_cache


log = logging.getLogger("embed-api.footprint")


class _RusageInfoV0(ctypes.Structure):
    # Darwin sys/resource.h: RUSAGE_INFO_V0, available since macOS 10.9.
    # Keep the full ABI, including the trailing process-lifetime fields.
    _fields_ = [
        ("ri_uuid", ctypes.c_uint8 * 16),
        ("ri_user_time", ctypes.c_uint64),
        ("ri_system_time", ctypes.c_uint64),
        ("ri_pkg_idle_wkups", ctypes.c_uint64),
        ("ri_interrupt_wkups", ctypes.c_uint64),
        ("ri_pageins", ctypes.c_uint64),
        ("ri_wired_size", ctypes.c_uint64),
        ("ri_resident_size", ctypes.c_uint64),
        ("ri_phys_footprint", ctypes.c_uint64),
        ("ri_proc_start_abstime", ctypes.c_uint64),
        ("ri_proc_exit_abstime", ctypes.c_uint64),
    ]


@lru_cache(maxsize=1)
def _load_proc_pid_rusage():
    library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    read = library.proc_pid_rusage
    read.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    read.restype = ctypes.c_int
    return read


def read_process_footprint_bytes(pid: int | None = None) -> int | None:
    """Return ri_phys_footprint, never RSS, peak memory or allocator counters.

    A failed kernel read stays unavailable so the caller can refuse inference.
    It is not replaced with a cached value or a weaker memory metric.
    """

    if sys.platform != "darwin":
        return None
    try:
        read = _load_proc_pid_rusage()
    except (OSError, AttributeError) as error:
        log.warning("proc_pid_rusage unavailable: %s", type(error).__name__)
        return None
    info = _RusageInfoV0()
    ctypes.set_errno(0)
    status = read(pid or os.getpid(), 0, ctypes.byref(info))
    if status != 0:
        log.warning(
            "proc_pid_rusage failed: status=%d errno=%d", status, ctypes.get_errno()
        )
        return None
    return int(info.ri_phys_footprint)
