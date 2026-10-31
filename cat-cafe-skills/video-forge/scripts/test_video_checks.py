"""tts-check.py 和 timeline-check.py 的回归测试（不连真服务，TTS / ASR 用本机临时假服务）。

运行：python3 -m unittest discover -s cat-cafe-skills/video-forge/scripts -p 'test_*.py'
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
TTS_CHECK = HERE / "tts-check.py"
TIMELINE_CHECK = HERE / "timeline-check.py"


def tiny_wav() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 1600)
    return buf.getvalue()


class FakeServices:
    """一个假的 TTS + ASR 服务。plan 按调用顺序给出每次的行为。"""

    def __init__(self):
        self.tts_plan: list = []  # "ok" | 500 | "garbage"（200 但不是 WAV）
        self.asr_plan: list = []  # str（听到的文字）| 500 | None（{"text": null}）| "not-json"
        self.tts_calls = 0
        self.asr_calls = 0
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                self.rfile.read(length)
                if self.path == "/tts":
                    step = fake.tts_plan[fake.tts_calls] if fake.tts_calls < len(fake.tts_plan) else "ok"
                    fake.tts_calls += 1
                    if step == 500:
                        self.send_response(500)
                        self.end_headers()
                        return
                    body = b"not a wav" if step == "garbage" else tiny_wav()
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/wav")
                else:
                    step = fake.asr_plan[fake.asr_calls] if fake.asr_calls < len(fake.asr_plan) else ""
                    fake.asr_calls += 1
                    if step == 500:
                        self.send_response(500)
                        self.end_headers()
                        return
                    body = b"<html>oops</html>" if step == "not-json" else json.dumps({"text": step}, ensure_ascii=False).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        port = self.server.server_address[1]
        self.env = dict(os.environ, TTS_URL=f"http://127.0.0.1:{port}/tts", ASR_URL=f"http://127.0.0.1:{port}/asr")

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class TtsCheckTest(unittest.TestCase):
    def setUp(self):
        self.svc = FakeServices()
        self.tmp = Path(tempfile.mkdtemp(prefix="tts-check-test-"))
        self.out = self.tmp / "out"
        self.ref = self.tmp / "ref.wav"
        self.ref.write_bytes(tiny_wav())
        self.voices = self.tmp / "voices.json"
        self.voice = {"ref": str(self.ref), "ref_text": "参考"}
        self.write_voices({"narr": self.voice})

    def tearDown(self):
        self.svc.close()

    def write_voices(self, voices):
        self.voices.write_text(json.dumps(voices, ensure_ascii=False))

    def assert_input_rejected(self, r, note=""):
        self.assertEqual(r.returncode, 2, f"{note}: {r.stdout}{r.stderr}")
        self.assertFalse(self.out.exists(), f"{note}: nothing may be created on validation failure")
        self.assertEqual((self.svc.tts_calls, self.svc.asr_calls), (0, 0), f"{note}: no service call on bad input")

    def fresh_run(self):
        """每次运行前清掉上一次的输出目录和服务计数，子用例之间互不影响。"""
        shutil.rmtree(self.out, ignore_errors=True)
        self.svc.tts_calls = 0
        self.svc.asr_calls = 0

    def run_check_ref(self, wav, text):
        self.fresh_run()
        return subprocess.run([sys.executable, str(TTS_CHECK), "--check-ref", str(wav), text],
                              env=self.svc.env, capture_output=True, text=True, timeout=60)

    def run_record(self, lines, *extra):
        self.fresh_run()
        lines_path = self.tmp / "lines.json"
        lines_path.write_text(json.dumps(lines, ensure_ascii=False))
        return subprocess.run(
            [sys.executable, str(TTS_CHECK), str(lines_path), str(self.voices), str(self.out), *extra],
            env=self.svc.env, capture_output=True, text=True, timeout=60,
        )

    def test_success_writes_take_and_report(self):
        self.svc.asr_plan = ["从前有一座猫咖。"]
        r = self.run_record([{"id": "s1-01", "who": "narr", "text": "从前，有一座猫咖。"}])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.out / "s1-01.wav").exists())
        report = json.loads((self.out / "takes.json").read_text())
        self.assertEqual(report[0]["flag"], "OK")
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["s1-01.wav", "takes.json"])

    def test_rejects_ids_that_escape_out_dir_before_writing_anything(self):
        outside = self.tmp / "outside.wav"
        outside.write_bytes(b"keep me")
        for bad in ["../outside", "/tmp/x", "a/b", "..", "", "a*", "a?b", "[x]", " lead"]:
            with self.subTest(id=bad):
                r = self.run_record([{"id": bad, "who": "narr", "text": "一句话。"}])
                self.assert_input_rejected(r, f"id={bad!r}")
                self.assertEqual(outside.read_bytes(), b"keep me")

    def test_rejects_duplicate_ids_and_unknown_voice(self):
        r = self.run_record([{"id": "a", "who": "narr", "text": "一。"}, {"id": "a", "who": "narr", "text": "二。"}])
        self.assert_input_rejected(r, "duplicate id")
        r = self.run_record([{"id": "a", "who": "ghost", "text": "一。"}])
        self.assert_input_rejected(r, "unknown voice")
        r = self.run_record([{"id": "a", "who": "narr", "text": ""}])
        self.assert_input_rejected(r, "empty text")

    def test_rejects_wrong_types_in_lines_before_any_call(self):
        good = {"id": "a", "who": "narr", "text": "一句话。"}
        bad_lines = {
            "who list": [dict(good, who=[])],
            "who dict": [dict(good, who={})],
            "who number": [dict(good, who=1)],
            "text number": [dict(good, text=123)],
            "mood number": [dict(good, mood=123)],
            "line not object": ["一句话。"],
            "lines not list": {"a": good},
            "lines empty": [],
        }
        for name, lines in bad_lines.items():
            with self.subTest(case=name):
                self.assert_input_rejected(self.run_record(lines), name)

    def test_rejects_wrong_types_in_voices_before_any_call(self):
        line = [{"id": "a", "who": "narr", "text": "一句话。"}]
        bad_voices = {
            "base number": {"narr": dict(self.voice, base=123)},
            "speed string": {"narr": dict(self.voice, speed="fast")},
            "speed zero": {"narr": dict(self.voice, speed=0)},
            "speed negative": {"narr": dict(self.voice, speed=-1)},
            "speed bool": {"narr": dict(self.voice, speed=True)},
            "speed NaN": {"narr": dict(self.voice, speed=float("nan"))},
            "speed infinite": {"narr": dict(self.voice, speed=float("inf"))},
            "ref_text number": {"narr": dict(self.voice, ref_text=123)},
            "ref missing file": {"narr": dict(self.voice, ref=str(self.tmp / "nope.wav"))},
            "voice not object": {"narr": "ref.wav"},
            "voices not object": [self.voice],
        }
        for name, voices in bad_voices.items():
            with self.subTest(case=name):
                self.write_voices(voices)
                self.assert_input_rejected(self.run_record(line), name)

    def test_optional_voice_fields_accept_valid_values(self):
        self.write_voices({"narr": dict(self.voice, base="平静地说", speed=0.95)})
        self.svc.asr_plan = ["一句话"]
        r = self.run_record([{"id": "a", "who": "narr", "text": "一句话。", "mood": "轻声"}])
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_check_ref_rejects_bad_input_and_flags_mismatch(self):
        r = self.run_check_ref(self.tmp / "nope.wav", "参考")
        self.assertEqual(r.returncode, 2, r.stderr)
        r = self.run_check_ref(self.ref, "  ")
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertEqual(self.svc.asr_calls, 0)
        r = self.run_check_ref(self.tmp / "nope.wav", "参考")
        self.assertEqual(self.svc.asr_calls, 0)
        self.svc.asr_plan = ["完全不同的一句话"]
        self.assertEqual(self.run_check_ref(self.ref, "参考").returncode, 1)
        self.svc.asr_plan = ["参考"]
        self.assertEqual(self.run_check_ref(self.ref, "参考").returncode, 0)

    def test_asr_failure_leaves_no_temp_take(self):
        self.svc.asr_plan = [500]
        r = self.run_record([{"id": "line1", "who": "narr", "text": "一句话。"}])
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual([p.name for p in self.out.iterdir()], [])

    def test_tts_failure_on_retry_leaves_no_temp_take(self):
        self.svc.asr_plan = ["完全不一样的话"]
        self.svc.tts_plan = ["ok", 500]
        r = self.run_record([{"id": "line1", "who": "narr", "text": "一句话。"}])
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual([p.name for p in self.out.iterdir()], [])

    def test_malformed_service_replies_fail_cleanly(self):
        cases = {"TTS returns non-WAV": (["garbage"], ["一句话"]),
                 "ASR text is null": (["ok"], [None]),
                 "ASR reply is not JSON": (["ok"], ["not-json"])}
        for name, (tts, asr) in cases.items():
            with self.subTest(case=name):
                self.svc.tts_plan, self.svc.asr_plan = tts, asr
                r = self.run_record([{"id": "line1", "who": "narr", "text": "一句话。"}])
                self.assertEqual(r.returncode, 1, f"{name}: {r.stderr}")
                self.assertNotIn("Traceback", r.stderr)
                self.assertEqual([p.name for p in self.out.iterdir()], [], name)

    def test_all_chk_keeps_best_take_and_cleans_up(self):
        self.svc.asr_plan = ["不对", "一句", "不对"]
        r = self.run_record([{"id": "line1", "who": "narr", "text": "一句话。"}])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["line1.wav", "takes.json"])
        self.assertEqual(json.loads((self.out / "takes.json").read_text())[0]["flag"], "CHK")

    def test_rejects_bad_tries_and_min_score(self):
        line = [{"id": "a", "who": "narr", "text": "一。"}]
        for extra in (["--tries", "0"], ["--tries", "-1"], ["--min-score", "1.5"], ["--min-score", "-0.1"],
                      ["--min-score", "nan"], ["--min-score", "inf"]):
            with self.subTest(extra=extra):
                self.assert_input_rejected(self.run_record(line, *extra), str(extra))


class TimelineCheckTest(unittest.TestCase):
    def run_check(self, data, *extra):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(data, f)
        return subprocess.run([sys.executable, str(TIMELINE_CHECK), f.name, *extra],
                              capture_output=True, text=True, timeout=30)

    def base(self):
        return {
            "fps": 30,
            "total": 90,
            "cuts": [{"id": "C1", "from_": 0, "dur": 45}, {"id": "C2", "from_": 45, "dur": 45}],
            "events": [
                {"k": "line", "at": 0, "dur": 30, "text": "第一句"},
                {"k": "line", "at": 40, "dur": 40, "text": "第二句"},
                {"k": "sfx", "at": 50},
            ],
        }

    def test_valid_timeline_passes(self):
        r = self.run_check(self.base())
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_existing_problems_still_fail(self):
        overlap = self.base()
        overlap["events"][1]["at"] = 20
        tight = self.base()
        tight["events"][1]["at"] = 33
        gap = self.base()
        gap["cuts"][1]["from_"] = 50
        gap["cuts"][1]["dur"] = 40
        for name, data in (("overlap", overlap), ("tight", tight), ("gap", gap)):
            with self.subTest(case=name):
                self.assertEqual(self.run_check(data).returncode, 1)

    def test_incomplete_or_malformed_timelines_fail(self):
        cases = {}
        head = self.base()
        head["cuts"] = [{"id": "C1", "from_": 30, "dur": 60}]
        head["events"] = []
        cases["head missing"] = head
        tail = self.base()
        tail["cuts"] = [{"id": "C1", "from_": 0, "dur": 30}]
        tail["events"] = []
        cases["tail missing"] = tail
        past_end = self.base()
        past_end["total"] = 30
        past_end["cuts"] = [{"id": "C1", "from_": 0, "dur": 30}]
        past_end["events"] = [{"k": "line", "at": 20, "dur": 50, "text": "太长"}]
        cases["speech past end"] = past_end
        negative = self.base()
        negative["events"][0]["dur"] = -5
        cases["negative duration"] = negative
        neg_at = self.base()
        neg_at["events"][0]["at"] = -1
        cases["negative start"] = neg_at
        zero_cut = self.base()
        zero_cut["cuts"][0]["dur"] = 0
        cases["zero-length cut"] = zero_cut
        not_number = self.base()
        not_number["events"][0]["dur"] = "30"
        cases["string duration"] = not_number
        boolean = self.base()
        boolean["cuts"][0]["dur"] = True
        cases["boolean duration"] = boolean
        bad_fps = self.base()
        bad_fps["fps"] = 0
        cases["fps 0"] = bad_fps
        sfx_out = self.base()
        sfx_out["events"][2]["at"] = 200
        cases["sfx past end"] = sfx_out
        unknown_kind = self.base()
        unknown_kind["events"].append({"k": "lien", "at": 85, "dur": 2})
        cases["unknown event kind"] = unknown_kind
        nan_fps = self.base()
        nan_fps["fps"] = float("nan")
        cases["fps NaN"] = nan_fps
        inf_fps = self.base()
        inf_fps["fps"] = float("inf")
        cases["fps infinite"] = inf_fps
        text_number = self.base()
        text_number["events"][0]["text"] = 123
        cases["speech text not string"] = text_number
        sfx_at_end = self.base()
        sfx_at_end["events"][2] = {"k": "sfx", "at": 90}
        cases["sfx at total, no dur"] = sfx_at_end
        sfx_at_end_dur0 = self.base()
        sfx_at_end_dur0["events"][2] = {"k": "sfx", "at": 90, "dur": 0}
        cases["sfx at total, dur 0"] = sfx_at_end_dur0
        cases["empty object"] = {}
        cases["not an object"] = []
        for name, data in cases.items():
            with self.subTest(case=name):
                r = self.run_check(data)
                self.assertEqual(r.returncode, 1, f"{name}: {r.stdout}{r.stderr}")
                self.assertNotIn("没有问题", r.stdout)


    def test_event_on_last_frame_is_allowed(self):
        data = self.base()
        data["events"][2] = {"k": "sfx", "at": 89}
        self.assertEqual(self.run_check(data).returncode, 0)

    def gap_case(self):
        data = self.base()
        data["events"] = [{"k": "line", "at": 0, "dur": 30, "text": "一"}, {"k": "line", "at": 31, "dur": 30, "text": "二"}]
        return data

    def test_gap_argument_must_be_finite_and_non_negative(self):
        data = self.gap_case()
        self.assertEqual(self.run_check(data).returncode, 1, "default 0.3 s must flag a 0.03 s gap")
        for bad in ("nan", "-1", "inf"):
            with self.subTest(gap=bad):
                r = self.run_check(data, "--gap", bad)
                self.assertNotEqual(r.returncode, 0)
                self.assertNotIn("没有问题", r.stdout)
        self.assertEqual(self.run_check(data, "--gap", "0").returncode, 0, "--gap 0 is a valid choice")


if __name__ == "__main__":
    unittest.main()
