import importlib.util
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('archive_dedup', Path(__file__).with_name('deduplicate-release-archives.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


@unittest.skipUnless(sys.platform == 'darwin', 'native APFS cloning')
class ArchiveDeduplication(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='cc-archive-dedup-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve() / '.worktree-release-archives'
        self.root.mkdir(mode=0o700)
        self.paths = []
        self.payload = os.urandom(1024 * 1024)
        for name in ['first', 'second']:
            path = self.root / name / 'files/proof.bin'
            path.parent.mkdir(parents=True)
            path.write_bytes(self.payload)
            self.paths.append(path)
            (self.root / name / 'manifest.json').write_text(json.dumps(dict(originals=[dict(
                path='proof.bin', kind='file', mode=0o644, bytes=len(self.payload),
                sha256=hashlib.sha256(self.payload).hexdigest())])))

    def test_copies_are_independent_and_preserve_original_metadata_and_manifests(self):
        second = self.paths[1]
        os.utime(second, ns=(1700000000123456789, 1700000000234567890))
        subprocess.run(['/usr/bin/xattr', '-w', 'org.catcafe.fixture', 'keep-original', str(second)], check=True)
        plan = MODULE.make_plan(str(self.root))
        manifests = {p: p.read_bytes() for p in self.root.glob('*/manifest.json')}
        receipt = self.root.parent / 'receipt.jsonl'
        self.assertEqual(MODULE.apply_plan(plan, receipt), 1)
        self.assertNotEqual(self.paths[0].stat().st_ino, second.stat().st_ino)
        self.assertEqual(second.stat().st_mtime_ns, 1700000000234567890)
        self.assertEqual(subprocess.check_output(['/usr/bin/xattr', '-p', 'org.catcafe.fixture', str(second)]).strip(), b'keep-original')
        for path, original in manifests.items():
            self.assertEqual(path.read_bytes(), original)
        second.write_bytes(b'changed independently')
        self.assertEqual(self.paths[0].read_bytes(), self.payload)
        self.assertIn('"state": "completed"', receipt.read_text())

    def test_changed_file_refuses_replacement(self):
        plan = MODULE.make_plan(str(self.root))
        self.paths[1].write_bytes(b'new original')
        with self.assertRaisesRegex(ValueError, 'changed since plan'):
            MODULE.apply_plan(plan, self.root.parent / 'receipt.jsonl')
        self.assertEqual(self.paths[1].read_bytes(), b'new original')

    def test_symlink_is_refused_without_changing_external_provider(self):
        plan = MODULE.make_plan(str(self.root))
        # A frozen plan cannot select a symlink/provider outside the archive.
        self.paths[1].unlink()
        self.paths[1].symlink_to(self.paths[0])
        with self.assertRaisesRegex(ValueError, 'symlink'):
            MODULE.apply_plan(plan, self.root.parent / 'receipt.jsonl')
        self.assertEqual(self.paths[0].read_bytes(), self.payload)
        self.assertEqual(list(self.root.glob('*/files/.clone-*')), [])

    def test_atomic_replace_failure_keeps_original_and_removes_temporary_and_rollback(self):
        plan = MODULE.make_plan(str(self.root))
        with patch.object(MODULE.os, 'replace', side_effect=OSError('fixture replacement failure')):
            with self.assertRaisesRegex(OSError, 'replacement failure'):
                MODULE.apply_plan(plan, self.root.parent / 'receipt.jsonl')
        for path in self.paths:
            self.assertEqual(path.read_bytes(), self.payload)
        self.assertEqual(list(self.root.glob('*/files/.*')), [])

    def edit_during_receipt_flush(self, state):
        plan = MODULE.make_plan(str(self.root))
        receipt = self.root.parent / 'receipt.jsonl'
        original = self.paths[1]
        edited = b'new edit' + self.payload[8:]
        real_fsync = MODULE.os.fsync
        changed = False

        def fsync_then_edit(fd):
            nonlocal changed
            real_fsync(fd)
            if not changed and f'"state": "{state}"' in receipt.read_text():
                with original.open('r+b') if state == 'prepared' else next(original.parent.glob('.rollback-*')).open('r+b') as writer:
                    writer.write(edited)
                changed = True

        with patch.object(MODULE.os, 'fsync', side_effect=fsync_then_edit):
            with self.assertRaisesRegex(ValueError, 'original changed'):
                MODULE.apply_plan(plan, receipt)
        self.assertTrue(changed)
        self.assertEqual(original.read_bytes(), edited)
        self.assertEqual(self.paths[0].read_bytes(), self.payload)
        self.assertEqual(list(self.root.glob('*/files/.*')), [])
        if state == 'verified':
            rows = [json.loads(line) for line in receipt.read_text().splitlines()]
            self.assertEqual(rows[-1]['state'], 'rolled_back')
            self.assertEqual(rows[-1]['path'], str(original))

    def test_edit_during_prepared_flush_is_not_lost(self):
        self.edit_during_receipt_flush('prepared')

    def test_edit_of_replaced_inode_before_rollback_unlink_is_not_lost(self):
        self.edit_during_receipt_flush('verified')

    def test_flagged_original_is_reported_without_blocking_other_plan_entries(self):
        subprocess.run(['chflags', 'hidden', str(self.paths[1])], check=True)
        plan = MODULE.make_plan(str(self.root))
        self.assertEqual(len(plan['skipped']), 1)
        self.assertEqual(plan['groups'], [])
        self.assertEqual(self.paths[1].read_bytes(), self.payload)


if __name__ == '__main__':
    unittest.main()
