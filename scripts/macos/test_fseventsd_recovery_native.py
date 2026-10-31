import json
import os
from pathlib import Path
import plistlib
import pwd
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fseventsd_recovery_native import BINARY, FILE_LIMIT, NativeHost, bounded_tool, parse_processes
from fseventsd_recovery_store import RecoveryStore
from install_fseventsd_recovery import BUNDLE, RUNTIME_PYTHON, bootstrap_arguments, launch_definition, read_bundle, require_no_acl, safe_root_path, verify_runtime
import install_fseventsd_recovery as installer_module


def row():
    return {"pid": 123, "startedAt": "Fri Oct 16 10:00:00 2026", "rssKb": 16 * 1024 ** 2,
            "totalMemoryKb": 128 * 1024 ** 2, "cpuPercent": 100, "memoryFreePercent": 60}


class NativeTests(unittest.TestCase):
    def test_exact_system_process_identity_and_ambiguous_or_fake_names(self):
        text = " 123 1 0 Fri Oct 16 10:00:00 2026 16777216 100.0 " + BINARY
        self.assertEqual(parse_processes(text), {key: value for key, value in row().items()
                                               if key not in ["totalMemoryKb", "memoryFreePercent"]})
        for bad in ["", text + "\n" + text, text.replace(" 1 0 ", " 1 501 "),
                    text.replace(BINARY, "/tmp/fseventsd"), text.replace(" 1 0 ", " 2 0 ")]:
            with self.assertRaises(RuntimeError):
                parse_processes(bad)

    def test_native_signal_rechecks_pressure_identity_and_privilege(self):
        native = NativeHost()
        for change in ["pid", "startedAt", "rssKb", "healthy", "root"]:
            current = row()
            if change in ["pid", "startedAt", "rssKb"]:
                current[change] = {"pid": 456, "startedAt": "new birth", "rssKb": 1024}[change]
            if change == "healthy":
                current["cpuPercent"] = 0
            with patch.object(native, "observe", return_value=current), patch("os.kill") as kill:
                with patch("os.geteuid", return_value=501 if change == "root" else 0):
                    if change == "root":
                        with self.assertRaises(RuntimeError):
                            native.terminate(row())
                    else:
                        self.assertFalse(native.terminate(row()))
                kill.assert_not_called()
        with patch.object(native, "observe", return_value=row()), patch("os.geteuid", return_value=0), patch("os.kill") as kill:
            self.assertTrue(native.terminate(row()))
            kill.assert_called_once_with(123, 15)

    def test_native_capture_has_fixed_no_content_tools_and_checks_each_target(self):
        native = NativeHost()
        changed = {**row(), "pid": 456}
        with tempfile.TemporaryDirectory() as root, patch.object(native, "observe", side_effect=[row(), changed]):
            with patch("fseventsd_recovery_native.bounded_tool", return_value={"exitCode": 0}) as tool:
                native.capture(row(), root)
                self.assertEqual(tool.call_count, 1)
                self.assertEqual(tool.call_args[0][0], ["/usr/bin/vmmap", "-summary", "123"])
        with tempfile.TemporaryDirectory() as root, patch.object(native, "observe", return_value=row()):
            with patch("fseventsd_recovery_native.bounded_tool", return_value={"exitCode": 0}) as tool:
                native.capture(row(), root)
                self.assertIn("-noContent", tool.call_args_list[1][0][0])
                self.assertEqual([item[0][0][0] for item in tool.call_args_list],
                                 ["/usr/bin/vmmap", "/usr/bin/heap", "/usr/bin/sample"])

    def test_real_diagnostic_child_cannot_exceed_file_budget(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "output.txt"
            result = bounded_tool([sys.executable, "-I", "-S", "-c",
                                   "import os; data=b'x'*1048576\nwhile True: os.write(1,data)"], output)
            self.assertLessEqual(output.stat().st_size, FILE_LIMIT)
            self.assertNotEqual(result["exitCode"], 0)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_timed_out_diagnostic_child_is_reaped_without_signalling_the_target(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "output.txt"
            result = bounded_tool([sys.executable, "-I", "-S", "-c", "import time; time.sleep(60)"],
                                  output, timeout=.05)
            self.assertEqual(result["exitCode"], "timeout")

    def test_replacement_needs_three_samples_of_the_same_new_instance(self):
        native = NativeHost()
        replacement = {**row(), "pid": 456, "rssKb": 1024}
        with patch("time.sleep"), patch.object(native, "observe", side_effect=[row(), replacement, replacement, replacement]) as observe:
            result = native.wait_replacement(row())
        self.assertEqual(observe.call_count, 4)
        self.assertTrue(result["healthy"])
        self.assertEqual(result["consecutiveReplacementSamples"], 3)


class StorageTests(unittest.TestCase):
    def make_store(self, root, **kwargs):
        return RecoveryStore(root=root, owner=os.getuid(), check_ancestors=False, minimum_free=0, **kwargs)

    def test_durable_state_and_healthy_noop_preserve_inode(self):
        with tempfile.TemporaryDirectory() as root, self.make_store(root) as store:
            store.save({})
            self.assertFalse((Path(root) / "state.json").exists())
            state = {"lastAttemptAt": 1000, "lastTarget": {"pid": 123, "startedAt": "birth"}}
            store.save(state)
            before = (Path(root) / "state.json").stat()
            store.save(state)
            after = (Path(root) / "state.json").stat()
            self.assertEqual(before.st_ino, after.st_ino)
            self.assertEqual(before.st_mtime_ns, after.st_mtime_ns)
            self.assertEqual(store.read(), state)

    def test_symlinks_corruption_hardlinks_and_open_permissions_fail_closed(self):
        for variant in ["symlink", "corrupt", "hardlink", "mode"]:
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as root, self.make_store(root) as store:
                state = Path(root) / "state.json"
                if variant == "symlink":
                    state.symlink_to("missing")
                else:
                    store.save({"lastAttemptAt": 1000})
                    if variant == "corrupt":
                        state.write_text("{bad")
                    if variant == "hardlink":
                        os.link(state, Path(root) / "other")
                    if variant == "mode":
                        state.chmod(0o644)
                with self.assertRaises((RuntimeError, json.JSONDecodeError)):
                    store.read()

    def test_lock_excludes_second_tick_and_budget_retains_evidence(self):
        with tempfile.TemporaryDirectory() as root, self.make_store(root) as store:
            with self.assertRaises(BlockingIOError):
                with self.make_store(root):
                    self.fail("a concurrent tick entered")
            incident = store.new_incident(1000)
            store.report(incident, "before.json", row())
            with self.assertRaises(RuntimeError):
                self.make_store(root, evidence_limit=1).new_incident(1060)
            self.assertEqual(json.loads((incident / "before.json").read_text()), row())

    @unittest.skipUnless(sys.platform == "darwin", "native macOS ACL boundary")
    def test_posix_private_path_with_extended_acl_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            require_no_acl(Path(root))
            principal = pwd.getpwuid(os.getuid()).pw_name
            subprocess.run(["/bin/chmod", "+a", "user:" + principal + " allow write", root], check=True)
            with self.assertRaises(RuntimeError):
                self.make_store(root)


class InstallationTests(unittest.TestCase):
    def test_filesystem_install_waits_for_native_baseline_and_uninstall_retains_bundle(self):
        version, _ = read_bundle(Path(__file__).parent)
        for capability in [False, True]:
            with self.subTest(capability=capability), tempfile.TemporaryDirectory() as root:
                base = Path(root) / "helpers"
                plist = Path(root) / "daemon.plist"
                calls = []
                def execute(arguments, timeout=20):
                    calls.append(arguments)
                    if not capability and arguments[-1] == "--baseline":
                        raise subprocess.CalledProcessError(1, arguments)
                # Real file publication, fixture-only ownership bypass and OS
                # calls recorded instead of invoking root Python/launchctl.
                with patch.object(installer_module, "BASE", base), patch.object(installer_module, "PLIST", plist):
                    with patch.object(installer_module, "safe_root_path"), patch.object(installer_module, "verify_runtime"):
                        with patch.object(installer_module, "checked", side_effect=execute):
                            if not capability:
                                with self.assertRaises(subprocess.CalledProcessError):
                                    installer_module.install(version)
                                self.assertFalse(plist.exists())
                                self.assertFalse(any("bootstrap" in args for args in calls))
                            else:
                                installer_module.install(version)
                                self.assertEqual(calls[0][-1], "--baseline")
                                self.assertEqual(calls[1][1], "bootstrap")
                                self.assertEqual(plistlib.loads(plist.read_bytes()), launch_definition(version))
                                installer_module.uninstall()
                                self.assertEqual(calls[-1][1], "bootout")
                                self.assertFalse(plist.exists())
                            self.assertTrue((base / version / BUNDLE[0]).is_file())

    def test_replaced_installer_never_executes_before_bootstrap_digest_check(self):
        with tempfile.TemporaryDirectory() as root:
            stage = Path(root)
            for name in BUNDLE:
                shutil.copyfile(Path(__file__).parent / name, stage / name)
            version, _ = read_bundle(stage)
            marker = stage / "unreviewed-code-executed"
            installer = stage / BUNDLE[-1]
            installer.write_text("from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('executed')\n" + installer.read_text())
            # Execute the real inline verifier without sudo. Hash failure occurs
            # before root authorization or any verified source execution.
            arguments = bootstrap_arguments(stage, version)[1:]
            arguments[0] = sys.executable
            result = subprocess.run(arguments, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no source code executed", result.stderr)
            self.assertFalse(marker.exists())

    def test_bootstrap_and_bundle_digest_agree_before_explicit_consent(self):
        directory = Path(__file__).parent
        version, _ = read_bundle(directory)
        arguments = bootstrap_arguments(directory, version)[1:]
        arguments[0] = sys.executable
        arguments[-1] = "--no-consent"
        result = subprocess.run(arguments, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("explicit recovery consent required", result.stderr)

    def test_bundle_digest_pins_all_executed_sources_and_changes_with_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            for name in BUNDLE:
                (directory / name).write_text(name)
            original, files = read_bundle(directory)
            self.assertEqual(set(files), set(BUNDLE))
            (directory / BUNDLE[0]).write_text("modified")
            self.assertNotEqual(read_bundle(directory)[0], original)
            (directory / BUNDLE[0]).unlink()
            (directory / BUNDLE[0]).symlink_to(directory / BUNDLE[1])
            with self.assertRaises(RuntimeError):
                read_bundle(directory)

    def test_launch_definition_roundtrips_without_mutable_paths_or_env_hooks(self):
        definition = launch_definition("a" * 64)
        self.assertEqual(plistlib.loads(plistlib.dumps(definition)), definition)
        self.assertEqual(definition["ProgramArguments"][:4], [str(RUNTIME_PYTHON), "-I", "-S", "-B"])
        self.assertTrue(str(RUNTIME_PYTHON).startswith("/Library/Developer/CommandLineTools/"))
        self.assertEqual(definition["ProgramArguments"][-1], "--recover")
        self.assertNotIn("EnvironmentVariables", definition)
        self.assertEqual(definition["StartInterval"], 60)
        self.assertEqual(definition["Umask"], 0o077)
        with self.assertRaises(RuntimeError):
            launch_definition("../../arbitrary")

    def test_root_installer_refuses_a_user_writable_ancestor(self):
        with tempfile.TemporaryDirectory() as root:
            child = Path(root) / "child"
            child.mkdir()
            with self.assertRaises(RuntimeError):
                safe_root_path(child)

    def test_untrusted_interpreter_is_rejected_before_executing_it(self):
        with tempfile.TemporaryDirectory() as root:
            candidate = Path(root) / "bin" / "python3"
            candidate.parent.mkdir()
            candidate.write_text("untrusted executable")
            with patch("install_fseventsd_recovery.RUNTIME_PYTHON", candidate):
                with patch("install_fseventsd_recovery.checked") as execute:
                    with self.assertRaises(RuntimeError):
                        verify_runtime()
                    execute.assert_not_called()

    def test_checkout_recover_entry_cannot_signal_or_create_root_state(self):
        main = Path(__file__).parent / "fseventsd_recovery.py"
        result = subprocess.run([sys.executable, "-I", "-S", str(main), "--recover"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("installed root-owned bundle", result.stderr)


if __name__ == "__main__":
    unittest.main()
