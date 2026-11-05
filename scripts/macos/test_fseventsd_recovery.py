import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fseventsd_recovery import capture_baseline, run_once
from fseventsd_recovery_policy import evaluate

GIB_KB = 1024 * 1024


def sample(pid=123, rss=16, cpu=100, free=60):
    return {"pid": pid, "startedAt": "Fri Oct 16 10:00:00 2026", "rssKb": rss * GIB_KB,
            "cpuPercent": cpu, "totalMemoryKb": 128 * GIB_KB, "memoryFreePercent": free}


class PolicyTests(unittest.TestCase):
    def test_sustained_critical_same_instance_becomes_capture_candidate(self):
        state = {}
        for now in [1000, 1060]:
            result = evaluate(sample(), state, now)
            self.assertEqual(result["action"], "observe")
            state = result["state"]
        self.assertEqual(evaluate(sample(), state, 1120)["action"], "capture")

    def test_advisory_alone_and_small_busy_process_never_recover(self):
        for row in [sample(rss=4), sample(rss=7), sample(rss=16, cpu=0), sample(rss=.01, free=1)]:
            with self.subTest(row=row):
                state = {}
                for now in [1000, 1060, 1120, 1180]:
                    result = evaluate(row, state, now)
                    self.assertEqual(result["action"], "observe")
                    state = result["state"]

    def test_changed_pid_start_or_healthy_sample_resets_the_streak(self):
        state = evaluate(sample(), {}, 1000)["state"]
        state = evaluate(sample(), state, 1060)["state"]
        changed_start = sample()
        changed_start["startedAt"] = "different birth"
        for row in [sample(pid=456), changed_start, sample(rss=.01)]:
            fresh = evaluate(row, copy.deepcopy(state), 1120)["state"]
            self.assertEqual(evaluate(sample(), fresh, 1180)["action"], "observe")

    def test_gap_backward_clock_and_duplicate_instant_do_not_accumulate(self):
        state = evaluate(sample(), {}, 1000)["state"]
        state = evaluate(sample(), state, 1060)["state"]
        for now in [900, 1060, 1500]:
            result = evaluate(sample(), copy.deepcopy(state), now)
            self.assertEqual(result["action"], "observe")
            self.assertLessEqual(result["state"].get("streak", {}).get("count", 0), 1)

    def test_cooldown_survives_new_pid_and_repeated_observation(self):
        for attempted_at in [1100, 1200]:
            state = {"lastAttemptAt": attempted_at}
            for now in [1200, 1260, 1320]:
                result = evaluate(sample(pid=456), state, now)
                self.assertEqual(result["action"], "observe")
                state = result["state"]
                self.assertEqual(state["lastAttemptAt"], attempted_at)

    def test_critical_memory_share_and_low_free_are_independent_signals(self):
        for row in [sample(rss=30, cpu=0), sample(rss=5, cpu=0, free=5)]:
            state = {}
            for now in [1000, 1060, 1120]:
                result = evaluate(row, state, now)
                state = result["state"]
            self.assertEqual(result["action"], "capture")

    def test_unreadable_values_fail_closed(self):
        for field in ["rssKb", "cpuPercent", "totalMemoryKb", "pid", "startedAt"]:
            row = sample()
            row[field] = None
            self.assertEqual(evaluate(row, {}, 1000)["action"], "observe")


class OrchestrationTests(unittest.TestCase):
    def fixture(self):
        row = sample()
        previous = evaluate(row, {}, 1000)["state"]
        previous = evaluate(row, previous, 1060)["state"]
        events = []
        store = Mock()
        store.read.return_value = previous
        store.new_incident.return_value = "/private/fixture/incident"
        store.save.side_effect = lambda state: events.append(("save", copy.deepcopy(state)))
        store.report.side_effect = lambda *args: events.append(("report", args[1]))
        native = Mock()
        native.observe.return_value = row
        native.capture.side_effect = lambda *args: events.append(("capture",)) or [{"exitCode": 0}]
        native.terminate.side_effect = lambda *args: events.append(("TERM",)) or True
        native.wait_replacement.return_value = {"pid": 456, "healthy": True}
        return native, store, events

    def test_durable_intent_then_capture_then_signal_then_replacement(self):
        native, store, events = self.fixture()
        result = run_once(native, store, 1120)
        self.assertEqual(result["action"], "term_sent")
        self.assertEqual(events[0][0], "save")
        self.assertEqual(events[0][1]["lastAttemptAt"], 1120)
        self.assertLess(events.index(("capture",)), events.index(("TERM",)))
        self.assertLess(events.index(("report", "signal-intent.json")), events.index(("TERM",)))
        native.wait_replacement.assert_called_once()

    def test_capture_failure_changed_identity_and_recovered_pressure_never_signal(self):
        for failure in ["capture", "pid", "start", "pressure", "late-change"]:
            native, store, events = self.fixture()
            if failure == "capture":
                native.capture.side_effect = lambda *args: [{"exitCode": 1}, {"exitCode": "timeout"}]
            elif failure == "late-change":
                native.terminate.side_effect = lambda *args: False
            else:
                changed = sample(pid=456) if failure == "pid" else sample()
                if failure == "start":
                    changed["startedAt"] = "new birth"
                if failure == "pressure":
                    changed["rssKb"] = 1000
                native.observe.side_effect = [sample(), changed]
            result = run_once(native, store, 1120)
            self.assertIn(result["action"], ["cancelled", "blocked"])
            self.assertNotIn(("TERM",), events)
            native.wait_replacement.assert_not_called()

    def test_storage_failure_and_capture_exception_never_signal(self):
        for failure in ["budget", "state", "capture", "signal-intent"]:
            native, store, events = self.fixture()
            if failure == "budget":
                store.new_incident.side_effect = OSError("budget")
            if failure == "state":
                store.save.side_effect = OSError("disk full")
            if failure == "capture":
                native.capture.side_effect = OSError("tool failure")
            if failure == "signal-intent":
                def report(_incident, name, _value):
                    if name == "signal-intent.json":
                        raise OSError("fsync failure")
                store.report.side_effect = report
            with self.assertRaises(OSError):
                run_once(native, store, 1120)
            native.terminate.assert_not_called()

    def test_healthy_tick_never_collects_or_controls(self):
        native, store, _ = self.fixture()
        native.observe.return_value = sample(rss=.01)
        self.assertEqual(run_once(native, store, 1120)["action"], "observe")
        native.capture.assert_not_called()
        native.terminate.assert_not_called()
        store.new_incident.assert_not_called()

    def test_baseline_verifies_native_capability_without_any_signal(self):
        native, store, _ = self.fixture()
        native.observe.return_value = sample(rss=.01)
        result = capture_baseline(native, store, 1120)
        self.assertEqual(result["action"], "baseline")
        self.assertTrue(result["nativeCaptureVerified"])
        native.terminate.assert_not_called()
        store.save.assert_not_called()

    def test_failed_or_changed_baseline_and_large_daemon_do_not_authorize_activation(self):
        for failure in ["native", "identity", "large"]:
            native, store, _ = self.fixture()
            native.observe.return_value = sample(rss=.01)
            if failure == "native":
                native.capture.side_effect = lambda *_args: [{"exitCode": 1}]
            if failure == "identity":
                native.observe.side_effect = [sample(rss=.01), sample(pid=456, rss=.01)]
            if failure == "large":
                native.observe.return_value = sample()
            with self.assertRaises(RuntimeError):
                capture_baseline(native, store, 1120)
            native.terminate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
