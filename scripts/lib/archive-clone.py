"""macOS copy-on-write copies with the destination original's complete metadata."""
import ctypes
import ctypes.util
import hashlib
import os

LIBC = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
LIBC.copyfile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_uint32]
LIBC.copyfile.restype = ctypes.c_int
LIBC.listxattr.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
LIBC.listxattr.restype = ctypes.c_ssize_t
LIBC.getxattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
LIBC.getxattr.restype = ctypes.c_ssize_t


class AttrList(ctypes.Structure):
    _fields_ = [('count', ctypes.c_uint16), ('reserved', ctypes.c_uint16),
                ('common', ctypes.c_uint32), ('volume', ctypes.c_uint32),
                ('directory', ctypes.c_uint32), ('file', ctypes.c_uint32), ('fork', ctypes.c_uint32)]


class TimeSpec(ctypes.Structure):
    _fields_ = [('seconds', ctypes.c_long), ('nanoseconds', ctypes.c_long)]


LIBC.getattrlist.argtypes = [ctypes.c_char_p, ctypes.POINTER(AttrList), ctypes.c_void_p, ctypes.c_size_t, ctypes.c_ulong]
LIBC.setattrlist.argtypes = LIBC.getattrlist.argtypes


def birthtime(path):
    attributes = AttrList(count=5, common=0x200)
    # Darwin's attribute buffer is packed at four bytes: length followed by timespec.
    result = ctypes.create_string_buffer(4 + ctypes.sizeof(TimeSpec))
    checked(LIBC.getattrlist(os.fsencode(path), ctypes.byref(attributes), result, ctypes.sizeof(result), 1))
    return TimeSpec.from_buffer_copy(result.raw[4:])


def checked(result):
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


def metadata(path):
    st = path.stat(follow_symlinks=False)
    encoded = os.fsencode(path)
    size = checked(LIBC.listxattr(encoded, None, 0, 0))
    names = ctypes.create_string_buffer(size)
    checked(LIBC.listxattr(encoded, names, size, 0))
    attrs = {}
    for name in sorted(names.raw.rstrip(b'\0').split(b'\0')) if size else []:
        length = checked(LIBC.getxattr(encoded, name, None, 0, 0, 0))
        value = ctypes.create_string_buffer(length)
        checked(LIBC.getxattr(encoded, name, value, length, 0, 0))
        attrs[os.fsdecode(name)] = hashlib.sha256(value.raw).hexdigest()
    return dict(mode=st.st_mode, uid=st.st_uid, gid=st.st_gid, mtimeNs=st.st_mtime_ns,
                birthtime=[birthtime(path).seconds, birthtime(path).nanoseconds], flags=st.st_flags, attrs=attrs)


def clone(canonical, original, temporary):
    checked(LIBC.copyfile(os.fsencode(canonical), os.fsencode(temporary), None, (1 << 25) | 15))
    checked(LIBC.copyfile(os.fsencode(original), os.fsencode(temporary), None, 7))
    # copyfile's STAT path may keep the clone provider's creation time.
    attributes = AttrList(count=5, common=0x200)
    created = birthtime(original)
    checked(LIBC.setattrlist(os.fsencode(temporary), ctypes.byref(attributes), ctypes.byref(created), ctypes.sizeof(created), 1))
