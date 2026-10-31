"""Bounded atomic directory exchange for the local file-reader regression test."""
import ctypes
import json
import os
import sys
import time

libc = ctypes.CDLL(None, use_errno=True)
left, right = (os.fsencode(value) for value in sys.argv[1:3])
if sys.platform == "darwin":
    exchange = libc.renamex_np
    exchange.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    args = (left, right, 2)  # RENAME_SWAP
elif sys.platform.startswith("linux"):
    exchange = libc.renameat2
    exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    args = (-100, left, -100, right, 2)  # AT_FDCWD / RENAME_EXCHANGE
else:
    raise SystemExit("unsupported test platform")
exchange.restype = ctypes.c_int
print("ready", flush=True)
deadline = time.monotonic() + 3
swaps = 0
while time.monotonic() < deadline:
    if exchange(*args) != 0:
        raise OSError(ctypes.get_errno(), "atomic exchange failed")
    swaps += 1
print(json.dumps({"swaps": swaps}), flush=True)
