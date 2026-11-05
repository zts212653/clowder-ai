#!/usr/bin/env python3
"""Explicit, bounded macOS archive deduplication; no compression, expiry or manifest mutation."""
import argparse
import collections
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import time
import uuid


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def identity(path):
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.getuid() or st.st_flags:
        raise ValueError(f'not an owned independent ordinary file: {path}')
    return [st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def child(root, relative):
    path = root / relative
    if path.resolve() != path or not path.is_relative_to(root) or path == root:
        raise ValueError(f'archive path escapes root or follows a symlink: {relative}')
    return path


def archive_root(value):
    root = Path(value).absolute()
    st = root.lstat()
    if root.resolve() != root or root.name != '.worktree-release-archives' or not stat.S_ISDIR(st.st_mode):
        raise ValueError('expected the real .worktree-release-archives directory')
    if st.st_uid != os.getuid():
        raise ValueError('archive root has another owner')
    return root


def make_plan(value, minimum=1024 * 1024):
    root = archive_root(value)
    groups = collections.defaultdict(list)
    skipped = []
    for directory in sorted(root.iterdir()):
        if not directory.is_dir() or directory.is_symlink():
            continue
        manifest_path = child(root, str(directory.relative_to(root) / 'manifest.json'))
        if not manifest_path.is_file():
            continue  # Incomplete archives remain untouched.
        manifest = json.loads(manifest_path.read_text())
        manifest_sha = digest(manifest_path)
        for item in manifest.get('originals', []):
            sha = item.get('sha256', '')
            if item.get('kind') != 'file' or item.get('bytes', 0) < minimum:
                continue
            if len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
                raise ValueError('invalid original checksum')
            relative = str(directory.relative_to(root) / 'files' / item['path'])
            path = child(root, relative)
            if path.lstat().st_flags:
                skipped.append(dict(path=relative, reason='file flags require operator inspection'))
                continue
            stamp = identity(path)
            if stamp[2] != item['bytes'] or stat.S_IMODE(path.stat().st_mode) != item['mode']:
                raise ValueError(f'original no longer matches manifest: {relative}')
            groups[(sha, stamp[2])].append(dict(path=relative, identity=stamp,
                                              manifest=str(manifest_path.relative_to(root)), manifestSha=manifest_sha))
    return dict(root=str(root), createdAt=time.time(), skipped=skipped, groups=[
        dict(sha256=sha, bytes=size, files=files) for (sha, size), files in groups.items() if len(files) > 1])


def verify_member(root, item, group):
    manifest = child(root, item['manifest'])
    if manifest.name != 'manifest.json' or manifest.parent.parent != root or digest(manifest) != item['manifestSha']:
        raise ValueError('archive manifest changed or is outside its package')
    path = child(root, item['path'])
    relative = path.relative_to(manifest.parent / 'files').as_posix()
    entries = json.loads(manifest.read_text()).get('originals', [])
    entry = next((entry for entry in entries if entry['path'] == relative), None)
    if not entry or entry.get('kind') != 'file' or entry.get('sha256') != group['sha256'] or entry.get('bytes') != group['bytes']:
        raise ValueError('plan member is not the manifest original')
    stamp = identity(path)
    if stamp != item['identity'] or stat.S_IMODE(path.stat().st_mode) != entry['mode'] or digest(path) != group['sha256']:
        raise ValueError('archive changed since plan')
    return path, stamp


def apply_plan(plan, receipt, limit=None):
    if sys.platform != 'darwin':
        raise ValueError('copy-on-write archive deduplication requires macOS')
    root = archive_root(plan['root'])
    helper = Path(__file__).parent / 'lib/archive-clone.py'
    spec = importlib.util.spec_from_file_location('archive_clone', helper)
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    count = 0
    with Path(receipt).open('x') as log:
        def record(value):
            log.write(json.dumps(value) + '\n')
            log.flush()
            os.fsync(log.fileno())

        for group in plan['groups']:
            canonical, canonical_identity = verify_member(root, group['files'][0], group)
            for item in group['files'][1:]:
                if limit is not None and count >= limit:
                    return count
                original, stamp = verify_member(root, item, group)
                manifest = child(root, item['manifest'])
                if identity(canonical) != canonical_identity:
                    raise ValueError('canonical original changed during deduplication')
                before = native.metadata(original)
                token = uuid.uuid4().hex
                temporary = original.with_name(f'.clone-{token}')
                rollback = original.with_name(f'.rollback-{token}')
                replaced = False
                try:
                    native.clone(canonical, original, temporary)
                    after = native.metadata(temporary)
                    if after != before or digest(temporary) != group['sha256']:
                        differences = [key for key in before if before[key] != after[key]]
                        raise ValueError(f'cloned content or metadata differs: {differences}')
                    if identity(original) != stamp or digest(manifest) != item['manifestSha']:
                        raise ValueError('original changed before atomic replacement')
                    record(dict(state='prepared', path=str(original), temporary=str(temporary), rollback=str(rollback)))
                    if identity(original) != stamp:
                        raise ValueError('original changed while preparing replacement')
                    os.link(original, rollback)
                    os.replace(temporary, original)
                    replaced = True
                    if native.metadata(original) != before or digest(original) != group['sha256']:
                        raise ValueError('replacement verification failed')
                    record(dict(state='verified', path=str(original), sha256=group['sha256'], bytes=group['bytes']))
                    # Linking changes ctime/nlink, so compare the prior inode/size/mtime and its actual contents.
                    rollback_stat = rollback.lstat()
                    if ([rollback_stat.st_dev, rollback_stat.st_ino, rollback_stat.st_size, rollback_stat.st_mtime_ns] != stamp[:4]
                            or native.metadata(rollback) != before or digest(rollback) != group['sha256']):
                        raise ValueError('original changed during replacement; restoring rollback')
                    rollback.unlink()
                    count += 1
                    time.sleep(0.01)
                except BaseException:
                    if replaced and rollback.exists():
                        os.replace(rollback, original)
                        record(dict(state='rolled_back', path=str(original), reason='original restored after replacement refusal'))
                    elif rollback.exists():
                        rollback.unlink()
                    raise
                finally:
                    if temporary.exists():
                        temporary.unlink()
        record(dict(state='completed', files=count))
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root')
    parser.add_argument('--plan')
    parser.add_argument('--apply-plan')
    parser.add_argument('--receipt')
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    if args.apply_plan:
        if not args.receipt:
            parser.error('--receipt is required for apply')
        count = apply_plan(json.loads(Path(args.apply_plan).read_text()), args.receipt, args.limit)
        print(json.dumps(dict(verifiedFiles=count)))
    else:
        if not args.root or not args.plan:
            parser.error('--root and --plan are required for dry run')
        plan = make_plan(args.root)
        with Path(args.plan).open('x') as output:
            json.dump(plan, output, indent=2)
        print(json.dumps(dict(groups=len(plan['groups']), duplicateLogicalGiB=sum(
            group['bytes'] * (len(group['files']) - 1) for group in plan['groups']) / 2**30,
            skippedFiles=len(plan['skipped']))))


if __name__ == '__main__':
    main()
