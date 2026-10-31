#!/usr/bin/env python3
"""给片子录声音稿：逐句合成，再用 Whisper 回听，对不上就重录。

来源：《醋醋喵》EP0（docs/videos/cucu-pr-flow/ep0-making-of.md 第 12–14 条）。

用法
  录音：python3 tts-check.py lines.json voices.json out_dir/
  核对参考音的文字：python3 tts-check.py --check-ref 参考音.wav "配的文字"

lines.json   [{"id": "s1-01", "who": "narr", "text": "从前，有一座猫咖。", "mood": "温柔地讲故事"}, ...]
voices.json  {"narr": {"ref": "/abs/path/ref.wav", "ref_text": "参考音里真正说的话",
                       "base": "用一个阳光可爱的小男孩语气讲故事", "speed": 0.95}, ...}

id 会直接当文件名：只能用字母、数字、点、横线、下划线，以字母或数字开头，不能重复。
who 要是声线表里的名字；ref 要是存在的音频文件；base、mood 是文字；speed 是大于 0 的有限数字。
输入有任何问题，在写出任何文件、调用任何服务之前就退出（退出码 2）。

输出 out_dir/<id>.wav 和 out_dir/takes.json（每句的秒数、听写结果、相似度）。
相似度低于 --min-score 的句子标 CHK：多半是同音词或人名写法不同，要人去听。

退出码
  0  每句都录好了，takes.json 已写出。注意：0 不代表每句都过关，标 CHK 的句子还要人去听。
  1  合成或听写服务出错（包括回的不是 WAV、听写没有文字），或 --check-ref 的文字和参考音对不上。
  2  输入不合法（台词表、声线表、参数）。
听写只当提醒，不当证据；它也证明不了配乐没盖住人声。

服务地址：TTS_URL（默认本机 mlx-audio 的 /v1/audio/speech）、ASR_URL（默认本机 Whisper 的 /v1/audio/transcriptions），
都可以用环境变量改。声线是克隆来的就只限私下用。
"""
import argparse
import difflib
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
import wave
from pathlib import Path

TTS_URL = os.environ.get("TTS_URL", "http://127.0.0.1:9879/v1/audio/speech")
ASR_URL = os.environ.get("ASR_URL", "http://127.0.0.1:9876/v1/audio/transcriptions")
MODEL = os.environ.get("TTS_MODEL", "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16")

SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}")

# 只改送去合成的文字，屏幕字幕照原文
SPEAK_FIX = {"／": "、", "～": "", "……": "，"}


class InputError(Exception):
    pass


def speak_text(t):
    for a, b in SPEAK_FIX.items():
        t = t.replace(a, b)
    return t.strip("，")


def norm(t):
    return re.sub(r"[^一-鿿A-Za-z0-9]", "", t).lower()


def similarity(a, b):
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def wav_seconds(p):
    with wave.open(str(p)) as w:
        return w.getnframes() / w.getframerate()


def asr(path):
    boundary = "----tts-check-" + hashlib.md5(str(path).encode()).hexdigest()
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"language\"\r\n\r\nzh\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\n"
        "Content-Type: audio/wav\r\n\r\n".encode(),
        Path(path).read_bytes(),
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    req = urllib.request.Request(ASR_URL, data=b"".join(parts),
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    reply = json.loads(urllib.request.urlopen(req, timeout=120).read())
    if not isinstance(reply, dict) or not isinstance(reply.get("text"), str):
        raise ValueError(f"听写服务的回复里没有文字：{str(reply)[:80]}")
    return reply["text"]


def synth(text, voice, mood, temperature):
    body = json.dumps({
        "input": speak_text(text), "voice": "zm_yunjian", "model": MODEL, "response_format": "wav",
        "speed": voice.get("speed", 1.0), "lang_code": "z",
        "ref_audio": voice["ref"], "ref_text": voice["ref_text"],
        "instruct": voice.get("base", "") + ("，" + mood if mood else ""),
        "temperature": temperature,
    }, ensure_ascii=False).encode()
    req = urllib.request.Request(TTS_URL, data=body, headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=180).read()


def load_json(path, what):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise InputError(f"{what} 读不了：{path}（{e}）")


def is_text(v):
    return isinstance(v, str) and bool(v.strip())


def validate_voice(who, v):
    if not isinstance(v, dict):
        raise InputError(f"声线 {who!r} 要是一个对象")
    for key in ("ref", "ref_text"):
        if not is_text(v.get(key)):
            raise InputError(f"声线 {who!r} 的 {key} 要是非空文字")
    if not Path(v["ref"]).is_file():
        raise InputError(f"声线 {who!r} 的参考音不存在：{v['ref']}")
    if "base" in v and not isinstance(v["base"], str):
        raise InputError(f"声线 {who!r} 的 base 要是文字")
    if "speed" in v:
        speed = v["speed"]
        if (isinstance(speed, bool) or not isinstance(speed, (int, float))
                or not math.isfinite(speed) or speed <= 0):
            raise InputError(f"声线 {who!r} 的 speed 要是大于 0 的有限数字，现在是 {speed!r}")


def validate(lines, voices):
    """录音前把输入全部查一遍；有问题就抛 InputError，这时还没有写任何文件、也没有调用任何服务。"""
    if not isinstance(voices, dict) or not voices:
        raise InputError("声线表要是一个非空对象：{\"narr\": {\"ref\": ..., \"ref_text\": ...}}")
    for who, v in voices.items():
        validate_voice(who, v)
    if not isinstance(lines, list) or not lines:
        raise InputError("台词表要是一个非空数组")
    seen = set()
    for i, line in enumerate(lines):
        if not isinstance(line, dict):
            raise InputError(f"第 {i + 1} 条台词要是一个对象")
        lid = line.get("id")
        if not isinstance(lid, str) or not SAFE_ID.fullmatch(lid):
            raise InputError(f"第 {i + 1} 条台词的 id {lid!r} 不能当文件名："
                             "只能用字母、数字、点、横线、下划线，以字母或数字开头，最长 100 个字符")
        if lid in seen:
            raise InputError(f"id {lid!r} 重复了")
        seen.add(lid)
        who = line.get("who")
        if not isinstance(who, str) or who not in voices:
            raise InputError(f"台词 {lid} 的 who={who!r} 要是声线表里的一个名字")
        if not isinstance(line.get("text"), str) or not norm(line["text"]):
            raise InputError(f"台词 {lid} 没有文字")
        if "mood" in line and not isinstance(line["mood"], str):
            raise InputError(f"台词 {lid} 的 mood 要是文字")


def record_line(line, voice, out, min_score, tries):
    """录一句，留下最好的一条，返回 (score, heard, target)。本次建的临时文件一律清掉。"""
    target = out / f"{line['id']}.wav"
    if target.resolve().parent != out.resolve():
        raise InputError(f"台词 {line['id']} 的输出路径跑出了 {out}")
    created = []
    best = None
    try:
        for k in range(tries):
            fd, name = tempfile.mkstemp(prefix=f".{line['id']}.try{k}.", suffix=".wav", dir=out)
            tmp = Path(name)
            created.append(tmp)
            with os.fdopen(fd, "wb") as f:
                f.write(synth(line["text"], voice, line.get("mood", ""), 0.3 + 0.1 * k))
            wav_seconds(tmp)  # 合成服务回的不是 WAV 时在这里就停，坏文件不会变成成品
            heard = asr(tmp)
            score = similarity(line["text"], heard)
            if best is None or score > best[0]:
                best = (score, tmp, heard)
            if score >= min_score:
                break
        score, tmp, heard = best
        os.replace(tmp, target)
        return score, heard, target
    finally:
        for p in created:
            try:
                p.unlink()
            except FileNotFoundError:
                pass


def record(lines, voices, out, min_score, tries):
    out.mkdir(parents=True, exist_ok=True)
    report = []
    for line in lines:
        score, heard, target = record_line(line, voices[line["who"]], out, min_score, tries)
        flag = "OK" if score >= min_score else "CHK"
        print(f"{flag:<3} {score:.2f} [{line['who']}] {line['text']}  ← 听到：{heard}", flush=True)
        report.append(dict(id=line["id"], who=line["who"], text=line["text"], heard=heard,
                           score=round(score, 3), seconds=round(wav_seconds(target), 3), flag=flag))
    (out / "takes.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    bad = [r for r in report if r["flag"] == "CHK"]
    print(f"\n{len(report)} 句录完，{len(bad)} 句标了 CHK，要人去听（退出码 0 不代表都过关）。"
          "时长写在 takes.json，时间轴从这里取。")


def unit_interval(s):
    v = float(s)
    if not math.isfinite(v) or not 0.0 <= v <= 1.0:
        raise argparse.ArgumentTypeError("要在 0 到 1 之间")
    return v


def positive_int(s):
    v = int(s)
    if v < 1:
        raise argparse.ArgumentTypeError("至少是 1")
    return v


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check-ref", nargs=2, metavar=("WAV", "TEXT"), help="核对一条参考音和它配的文字是否是同一句")
    ap.add_argument("lines", nargs="?")
    ap.add_argument("voices", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--min-score", type=unit_interval, default=0.85, help="低于它标 CHK（0–1，默认 0.85）")
    ap.add_argument("--tries", type=positive_int, default=3, help="每句最多录几次（默认 3）")
    a = ap.parse_args()
    try:
        if a.check_ref:
            wav, text = a.check_ref
            if not Path(wav).is_file():
                raise InputError(f"参考音不存在：{wav}")
            if not norm(text):
                raise InputError("--check-ref 要给参考音里说的那句话，现在是空的")
            heard = asr(wav)
            score = similarity(text, heard)
            print(f"配的文字：{text}\n听到的：  {heard}\n相似度：  {score:.2f}")
            sys.exit(0 if score >= 0.8 else 1)
        if not (a.lines and a.voices and a.out):
            ap.error("录音要三个参数：lines.json voices.json out_dir")
        lines = load_json(a.lines, "台词表")
        voices = load_json(a.voices, "声线表")
        validate(lines, voices)
        record(lines, voices, Path(a.out), a.min_score, a.tries)
    except InputError as e:
        print(f"输入有问题：{e}", file=sys.stderr)
        sys.exit(2)
    except (urllib.error.URLError, OSError, ValueError, EOFError, wave.Error) as e:
        print(f"合成或听写出错，已停下（本句的临时文件已清掉）：{e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
