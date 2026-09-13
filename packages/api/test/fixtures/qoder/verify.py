#!/usr/bin/env python3
"""F317 qoder fixture generation 验证器（唯一读方入口）。

fail-closed 契约：
- current 必须是 symlink 且解析后仍在 DEST 内；generation 目录与所有 artifact 必须是 regular file（拒绝 symlink）
- 目录名 `.gen-<h>` 的 <h> 必须等于 generation.json 内容 sha256 前 12 位
- schema/collector/collector_sha256 绑定：collector_sha256 必须等于本目录 collect.sh 的实际 sha256
  （退化/被改 collector 无法自洽通过）
- expect 精确匹配；side_effects 必须是精确五项集合（含 sandbox receipt）
- artifacts 四类全量 sha256 重算；.assert 必须含 "expressions:" 标记、≥1 条表达式行、末行 "<name>: ok"
- 目录内不得有缺失/额外/篡改文件
用法: python3 verify.py [DEST]   # 默认脚本所在目录
"""
import hashlib, json, os, re, sys

EXPECT = ["success", "tool-use", "permission-denial", "auth-error",
          "silent-model-fallback", "resume", "hook-red", "hook-green-project", "hook-green-local"]
ARTIFACT_SUFFIXES = ("jsonl", "stderr.txt", "exit", "assert")
SIDE_EFFECTS = {"permission-denial.side-effect", "hook-red.side-effect",
                "hook-green-project.side-effect", "hook-green-local.side-effect",
                "sandbox.side-effect"}
# receipt 语义契约：内容必须精确匹配（防"文件在、语义假"通过）
RECEIPT_CONTENT = {
    "permission-denial.side-effect": "target_absent=true\n",
    "hook-red.side-effect": "marker_present=true\n",
    "hook-green-project.side-effect": "marker_absent=true\n",
    "hook-green-local.side-effect": "marker_absent=true\n",
}
SCHEMA = "qoder-f317-generation/3"


def fail(msg):
    print(f"VERIFY FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def regular_file(path):
    return os.path.isfile(path) and not os.path.islink(path)


def main():
    dest = os.path.realpath(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))))
    current = os.path.join(dest, "current")
    if not os.path.islink(current):
        fail("current is not a symlink (no active generation)")
    target = os.readlink(current)
    # current 目标必须是裸规范名（拒绝任何斜杠/中转目录/非规范路径——与 publisher 输出一致）
    if not re.fullmatch(r"\.gen-[0-9a-f]{12}", target):
        fail(f"current target not canonical: {target!r}")
    gen_entry = os.path.join(dest, target)
    if os.path.islink(gen_entry):
        fail(f"generation entry is a symlink: {target}")
    gendir = os.path.realpath(gen_entry)
    if os.path.dirname(gendir) != dest or os.path.basename(gendir) == dest:
        fail(f"current escapes DEST: {target}")
    m = re.fullmatch(r"\.gen-([0-9a-f]{12})", os.path.basename(gendir))
    if not m:
        fail(f"generation dir name malformed: {os.path.basename(gendir)}")
    if os.path.islink(gendir):
        fail("generation dir is a symlink")

    manifest_path = os.path.join(gendir, "generation.json")
    if not regular_file(manifest_path):
        fail("generation.json not a regular file")
    raw = open(manifest_path, "rb").read()
    if hashlib.sha256(raw).hexdigest()[:12] != m.group(1):
        fail("generation dir name does not match generation.json digest")
    try:
        g = json.loads(raw)
    except Exception as e:
        fail(f"unreadable generation.json: {e}")

    if g.get("schema") != SCHEMA:
        fail(f"unexpected schema: {g.get('schema')}")
    # collector 指纹绑定：防退化 collector 自洽通过
    collector_path = os.path.join(dest, "collect.sh")
    if not regular_file(collector_path):
        fail("collect.sh missing or not a regular file")
    if g.get("collector") != "collect.sh" or g.get("collector_sha256") != sha(collector_path):
        fail("collector identity mismatch (generation not produced by current collect.sh)")
    if sorted(g.get("expect", [])) != sorted(EXPECT):
        fail(f"expect mismatch: {g.get('expect')}")
    if set(g.get("side_effects", {})) != SIDE_EFFECTS:
        fail(f"side_effects mismatch: {sorted(g.get('side_effects', {}))}")

    expected_files = {"generation.json"}
    for n in EXPECT:
        for s in ARTIFACT_SUFFIXES:
            h = g["artifacts"].get(n, {}).get(s)
            if not h:
                fail(f"manifest missing hash for {n}.{s}")
            p = os.path.join(gendir, f"{n}.{s}")
            if not regular_file(p):
                fail(f"missing or non-regular artifact {n}.{s}")
            if sha(p) != h:
                fail(f"hash mismatch: {n}.{s}")
            expected_files.add(f"{n}.{s}")
    for name, h in g.get("side_effects", {}).items():
        p = os.path.join(gendir, name)
        if not regular_file(p):
            fail(f"missing side-effect receipt {name}")
        if sha(p) != h:
            fail(f"hash mismatch: side-effect {name}")
        if name in RECEIPT_CONTENT and open(p).read() != RECEIPT_CONTENT[name]:
            fail(f"side-effect receipt semantic mismatch: {name}")
        if name == "sandbox.side-effect":
            txt = open(p).read()
            for required in ("fs_restricted: true", "canary_home_blocked: true",
                             "canary_tmp_blocked: true", "canary_var_tmp_blocked: true",
                             "canary_raw_allowed: true", "auth_clone_per_invocation: true",
                             "policy_location: outside-provider-writable-scope",
                             "bound_run_dir: "):
                if required not in txt:
                    fail("sandbox receipt semantic mismatch")
            if not re.search(r"^method: \S", txt, re.M) or not re.search(r"^profile_sha256: [0-9a-f]{64}", txt, re.M):
                fail("sandbox receipt semantic mismatch")
        expected_files.add(name)

    # .assert 强度检查：表达式清单 + 全部通过标记
    for n in EXPECT:
        lines = [l.rstrip("\n") for l in open(os.path.join(gendir, f"{n}.assert"))]
        if "expressions:" not in lines:
            fail(f"weak assert file: {n}.assert missing expressions marker")
        if lines and not lines[0].endswith(f"{n}: ok"):
            fail(f"assert file shows failure: {n}.assert")
        idx = lines.index("expressions:")
        if len(lines) - idx - 1 < 1:
            fail(f"weak assert file: {n}.assert records no expressions")

    actual = set(os.listdir(gendir))
    extra, missing = actual - expected_files, expected_files - actual
    if missing:
        fail(f"missing files: {sorted(missing)}")
    if extra:
        fail(f"extra/tampered files: {sorted(extra)}")

    print(f"verified generation {os.path.basename(gendir)}: {len(EXPECT)} fixtures, "
          f"{len(SIDE_EFFECTS)} side-effect receipts, collector-bound, all hashes match")


if __name__ == "__main__":
    main()
