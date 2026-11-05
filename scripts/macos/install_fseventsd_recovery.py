"""Explicit operator installation; no sudoers rule and no arbitrary command hook."""

import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import stat
import subprocess
import sys

LABEL = "org.cat-cafe.fseventsd-recovery"
BASE = Path("/Library/PrivilegedHelperTools/cat-cafe-fseventsd")
CLT_ROOT = Path("/Library/Developer/CommandLineTools")
RUNTIME_PYTHON = CLT_ROOT / "usr/bin/python3"
PLIST = Path("/Library/LaunchDaemons") / (LABEL + ".plist")
BUNDLE = ("fseventsd_recovery.py", "fseventsd_recovery_policy.py", "fseventsd_recovery_native.py",
          "fseventsd_recovery_store.py", "install_fseventsd_recovery.py")

# This literal is supplied as Python -c code in the reviewed operator command.
# Privileged startup never executes an installer from the mutable source tree.
BOOTSTRAP = '''import hashlib,os,pathlib,stat,sys
wanted,source,consent=sys.argv[1:]
if len(wanted)!=64 or any(c not in "0123456789abcdef" for c in wanted):
    raise SystemExit("invalid reviewed bundle hash")
root=pathlib.Path(source)
names=("fseventsd_recovery.py","fseventsd_recovery_policy.py","fseventsd_recovery_native.py","fseventsd_recovery_store.py","install_fseventsd_recovery.py")
parts={}; digest=hashlib.sha256()
for name in names:
    fd=os.open(str(root/name),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,"rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise SystemExit("non-regular bundle input")
        data=stream.read(131073)
    if len(data)>131072: raise SystemExit("bundle input too large")
    parts[name]=data; digest.update(name.encode()+b"\\0"+data)
if digest.hexdigest()!=wanted:
    raise SystemExit("reviewed bundle changed; no source code executed")
if consent!="--enable-recovery": raise SystemExit("explicit recovery consent required")
if os.geteuid()!=0 or sys.platform!="darwin": raise SystemExit("operator root authorization on macOS required")
os.umask(0o077)
namespace={"__name__":"verified_recovery_installer","__file__":str(root/names[-1])}
exec(compile(parts[names[-1]],"<verified recovery installer>","exec"),namespace)
namespace["install"](wanted)
'''


def bootstrap_arguments(directory, version):
    return ["/usr/bin/sudo", str(RUNTIME_PYTHON), "-I", "-S", "-B", "-c", BOOTSTRAP,
            version, str(directory.resolve()), "--enable-recovery"]


def require_no_acl(path):
    if sys.platform != "darwin":
        return
    # Darwin sys/acl.h: ACL_TYPE_EXTENDED=0x100. A valid open FD removes
    # pathname ENOENT ambiguity: Libc filesec_get_property uses ENOENT for
    # an absent FILESEC_ACL. See apple-oss-distributions/Libc posix1e/acl_file.c.
    # Refuse extended ACLs rather than inferring access from POSIX mode alone.
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    library.acl_get_fd_np.argtypes = [ctypes.c_int, ctypes.c_int]
    library.acl_get_fd_np.restype = ctypes.c_void_p
    library.acl_free.argtypes = [ctypes.c_void_p]
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        ctypes.set_errno(0)
        acl = library.acl_get_fd_np(descriptor, 0x100)
        error = ctypes.get_errno()
        if acl:
            library.acl_free(acl)
            raise RuntimeError("extended ACL on trusted recovery path: " + str(path))
        if error != errno.ENOENT:
            raise OSError(error, "cannot verify macOS ACL", str(path))
        opened, named = os.fstat(descriptor), path.lstat()
        if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
            raise RuntimeError("recovery path changed during ACL inspection")
    finally:
        os.close(descriptor)


def read_bundle(directory):
    values = {}
    digest = hashlib.sha256()
    for name in BUNDLE:
        path = directory / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError("bundle input must be a regular file: " + name)
        descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as source:
            data = source.read(128 * 1024 + 1)
        if len(data) > 128 * 1024:
            raise RuntimeError("unexpected helper input size")
        values[name] = data
        digest.update(name.encode() + b"\0" + data)
    return digest.hexdigest(), values


def launch_definition(version):
    if len(version) != 64 or any(letter not in "0123456789abcdef" for letter in version):
        raise RuntimeError("invalid bundle version")
    return {"Label": LABEL, "UserName": "root", "GroupName": "wheel", "Umask": 0o077,
            "ProgramArguments": [str(RUNTIME_PYTHON), "-I", "-S", "-B", str(BASE / version / BUNDLE[0]), "--recover"],
            "StartInterval": 60, "RunAtLoad": True, "ProcessType": "Background"}


def safe_root_path(path):
    for item in [*reversed(path.parents), path]:
        info = item.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError("unsafe root installation path: " + str(item))
        require_no_acl(item)


def durable_create(path, data, mode):
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    directory = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def checked(arguments, timeout=20):
    subprocess.run(arguments, check=True, timeout=timeout, env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C"})


def verify_runtime():
    # /usr/bin/python3 can dispatch through xcode-select into an application
    # beneath admin-writable /Applications. Persistent root execution instead
    # uses the existing, separately root-protected Command Line Tools runtime.
    safe_root_path(RUNTIME_PYTHON.parent)
    resolved = RUNTIME_PYTHON.resolve(strict=True)
    if CLT_ROOT not in resolved.parents or RUNTIME_PYTHON.lstat().st_uid != 0:
        raise RuntimeError("Python runtime escapes the protected Command Line Tools installation")
    safe_root_path(resolved)
    checked([str(RUNTIME_PYTHON), "-I", "-S", "-B", "-c", "import ctypes,fcntl,resource; import sys; assert sys.version_info >= (3,9)"])


def install(expected):
    version, values = read_bundle(Path(__file__).resolve().parent)
    if expected != version:
        raise RuntimeError("reviewed bundle hash changed; nothing installed")
    verify_runtime()
    safe_root_path(BASE.parent)
    safe_root_path(PLIST.parent)
    if PLIST.exists() or PLIST.is_symlink():
        raise RuntimeError("existing installation: uninstall explicitly before replacing it")
    BASE.mkdir(mode=0o755, exist_ok=True)
    safe_root_path(BASE)
    destination = BASE / version
    destination.mkdir(mode=0o700, exist_ok=True)
    safe_root_path(destination)
    for name, data in values.items():
        path = destination / name
        if path.exists() or path.is_symlink():
            safe_root_path(path)
            if not stat.S_ISREG(path.lstat().st_mode) or path.read_bytes() != data:
                raise RuntimeError("installed bundle differs: " + name)
        else:
            durable_create(path, data, 0o600)
    # Verify actual native diagnostic capability before enabling any automatic
    # action. Baseline is a separate root-only entry with no signal path.
    checked([str(RUNTIME_PYTHON), "-I", "-S", "-B", str(destination / BUNDLE[0]), "--baseline"], timeout=300)
    durable_create(PLIST, plistlib.dumps(launch_definition(version)), 0o644)
    # Installation is the only place launchctl is used. The helper cannot reload
    # itself, accept a target PID, invoke arbitrary scripts or change sudoers.
    try:
        checked(["/bin/launchctl", "bootstrap", "system", str(PLIST)])
    except Exception:
        PLIST.unlink()
        raise
    print(json.dumps({"installed": str(PLIST), "bundleSha256": version,
                      "uninstall": "/usr/bin/sudo " + str(RUNTIME_PYTHON) + " -I -S -B " + str(destination / BUNDLE[-1]) + " uninstall"}))


def uninstall():
    safe_root_path(PLIST)
    if not stat.S_ISREG(PLIST.lstat().st_mode):
        raise RuntimeError("unexpected installation type")
    definition = plistlib.loads(PLIST.read_bytes())
    args = definition.get("ProgramArguments", [])
    if len(args) != 6 or definition != launch_definition(Path(args[4]).parent.name):
        raise RuntimeError("refusing to alter an unrecognized launch daemon")
    checked(["/bin/launchctl", "bootout", "system/" + LABEL])
    PLIST.unlink()
    print(json.dumps({"uninstalled": str(PLIST), "evidenceRetained": True, "bundlesRetained": True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["plan", "uninstall"])
    parser.add_argument("--command-only", action="store_true")
    args = parser.parse_args()
    if args.action == "plan":
        source = Path(__file__).resolve().parent
        version, _ = read_bundle(source)
        command = shlex.join(bootstrap_arguments(source, version))
        if args.command_only:
            print(command)
            return
        print(json.dumps({"bundleSha256": version, "launchDaemon": launch_definition(version),
                          "stateRoot": "/private/var/db/cat-cafe-fseventsd",
                          "installCommand": command,
                          "activated": False}, indent=2))
        return
    if os.geteuid() != 0 or sys.platform != "darwin":
        raise RuntimeError("installation/removal requires operator root authorization on macOS")
    os.umask(0o077)
    if Path(__file__).resolve().parent.parent != BASE:
        raise RuntimeError("uninstall must use the installed root-owned command")
    uninstall()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
