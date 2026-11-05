"""Private, durable recovery intent and bounded evidence storage; no purging."""

import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import uuid

from install_fseventsd_recovery import require_no_acl

STATE_ROOT = Path("/private/var/db/cat-cafe-fseventsd")


def trusted(path, owner, directory=False):
    info = path.lstat()
    correct_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not correct_type or info.st_uid != owner or info.st_mode & 0o077:
        raise RuntimeError("unsafe private recovery path: " + str(path))
    if not directory and info.st_nlink != 1:
        raise RuntimeError("multiply linked recovery file: " + str(path))
    require_no_acl(path)


class RecoveryStore:
    def __init__(self, root=STATE_ROOT, owner=0, check_ancestors=True,
                 evidence_limit=4 * 1024 ** 3, minimum_free=2 * 1024 ** 3):
        self.root = Path(root)
        self.owner = owner
        self.evidence_limit = evidence_limit
        self.minimum_free = minimum_free
        if check_ancestors:
            for parent in reversed(self.root.parents):
                info = parent.lstat()
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                    raise RuntimeError("unsafe recovery ancestor: " + str(parent))
                require_no_acl(parent)
        self.root.mkdir(mode=0o700, exist_ok=True)
        trusted(self.root, owner, directory=True)
        self.lock = None

    def __enter__(self):
        self.lock = os.open(str(self.root / "lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            trusted(self.root / "lock", self.owner)
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            os.close(self.lock)
            self.lock = None
            raise
        return self

    def __exit__(self, *_args):
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None

    def read(self):
        path = self.root / "state.json"
        try:
            trusted(path, self.owner)
        except FileNotFoundError:
            return {}
        if path.stat().st_size > 65536:
            raise RuntimeError("recovery state exceeds size limit")
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise RuntimeError("invalid recovery state")
        return value

    def _write(self, path, value):
        trusted(path.parent, self.owner, directory=True)
        data = (json.dumps(value, sort_keys=True, allow_nan=False) + "\n").encode()
        if path.exists() or path.is_symlink():
            trusted(path, self.owner)
            if path.read_bytes() == data:
                return
        descriptor, temporary = tempfile.mkstemp(prefix=".pending-", dir=str(path.parent))
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
            directory = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def save(self, value):
        if not value and not (self.root / "state.json").exists():
            return
        self._write(self.root / "state.json", value)

    def report(self, incident, name, value):
        incident = Path(incident)
        if incident.parent != self.root or Path(name).name != name:
            raise RuntimeError("report outside fixed evidence root")
        self._write(incident / name, value)

    def new_incident(self, now):
        # Reserve enough for three bounded native reports and metadata. When
        # full, stop collecting/recovering; never erase incident evidence.
        used = 0
        for parent, directories, files in os.walk(self.root, followlinks=False):
            for name in directories:
                trusted(Path(parent) / name, self.owner, directory=True)
            for name in files:
                path = Path(parent) / name
                trusted(path, self.owner)
                used += path.stat().st_size
        reservation = 128 * 1024 ** 2
        if used + reservation > self.evidence_limit:
            raise RuntimeError("evidence budget full; archive retained evidence before retry")
        if shutil.disk_usage(self.root).free < self.minimum_free + reservation:
            raise RuntimeError("insufficient disk space for evidence-preserving recovery")
        path = self.root / ("incident-" + str(int(now)) + "-" + uuid.uuid4().hex)
        path.mkdir(mode=0o700)
        return path
