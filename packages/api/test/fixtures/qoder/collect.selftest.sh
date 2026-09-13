#!/usr/bin/env bash
# collect.sh 无额度合成回归（stub provider，不调用真实 qodercn、不消耗 credits）
# 正向(4): 增攻击韧性（policy 改写 + /tmp,/var/tmp,HOME 逃逸全被挡） 9 fixture 断言+发布+verify / 同代重跑 / 同代+异代并发发布竞争
# 负向(19, 全部断言具体错误类别): bad-output / extra-tool / wrong-path / wrong-result-id /
#       malicious-sid / missing-ids / missing-sid / clone-pollution / dirty-profile / missing-profile (collect 侧 10) +
#       tamper / extra-file / missing-side-effect / false-receipt / symlink-escape /
#       gen-alias / gen-symlink / gen-alias-dir / collector-mismatch (verifier 侧 9)
# sandbox 不再是自声明 receipt：collector 自建 sandbox-exec 边界 + 行为级 canary（HOME 拒写/RAW 可写）
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d /tmp/qoder-selftest.XXXXXX); trap 'rm -rf "$WORK"' EXIT
STUB="$WORK/qodercn"; PROF="$WORK/profile"; DEST="$WORK/dest"
mkdir -p "$PROF/.auth" "$DEST"; touch "$PROF/.auth/user"


cat > "$STUB" <<STUBEOF
#!/usr/bin/env bash
args="\$*"
SID="11111111-2222-3333-4444-555555555555"
CFGDIR=\$(echo "\$args" | grep -oE 'config-dir [^ ]+' | awk '{print \$2}')
if [ ! -e "\$CFGDIR/.auth/user" ]; then
  echo '{"type":"system","subtype":"init","tools":[],"mcp_servers":[],"model":"auto","permissionMode":"default","session_id":"'\$SID'"}'
  echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in","session_id":"'\$SID'"}'
  exit 1
fi
TOOLS=\$(echo "\$args" | grep -oE -- '--tools [^ ]+' | awk '{print \$2}')
case "\$TOOLS" in
  ''|'""') TJ="[]" ;;
  Read)  TJ='["Read"]' ;;
  Write) TJ='["Write"]' ;;
  *)     TJ='["Bash","Write","WebFetch"]' ;;
esac
if ! echo "\$args" | grep -q 'setting-sources user'; then
  for f in .qoder/settings.json .qoder/settings.local.json; do
    if [ -f "\$f" ] && grep -q touch "\$f"; then
      MARK=\$(grep -oE 'touch [^"]+' "\$f" | awk '{print \$2}')
      echo '{"type":"system","subtype":"hook_started","hook_name":"touch marker-file","session_id":"'\$SID'"}'
      touch "\$MARK"
    fi
  done
fi
echo '{"type":"system","subtype":"hook_started","hook_name":"builtin","session_id":"'\$SID'"}'
echo '{"type":"system","subtype":"init","tools":'\$TJ',"mcp_servers":[],"model":"Auto","permissionMode":"default","session_id":"'\$SID'"}'
if echo "\$args" | grep -qE '(^| )-r '; then
  echo '{"type":"result","subtype":"success","is_error":false,"result":"You asked me to reply with exactly ok.","session_id":"'\$SID'"}'
elif echo "\$args" | grep -q 'tool-input.txt'; then
  TF=\$(echo "\$args" | grep -oE '[^ ]*tool-input.txt' | head -1)
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"Read","input":{"file_path":"'\$TF'"}}]},"session_id":"'\$SID'"}'
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"1\tF317-DETERMINISTIC-LINE-1\n2\t"}]},"session_id":"'\$SID'"}'
  echo '{"type":"result","subtype":"success","is_error":false,"result":"F317-DETERMINISTIC-LINE-1","session_id":"'\$SID'"}'
elif echo "\$args" | grep -q pwned; then
  PF=\$(echo "\$args" | grep -oE '[^ ]*pwned[^ ]*' | sed "s/[.'\"]*$//" | head -1)
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c2","name":"Write","input":{"file_path":"'\$PF'","content":"x"}}]},"session_id":"'\$SID'"}'
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c2","content":"Error: Allow writing?","is_error":true}]},"session_id":"'\$SID'"}'
  echo '{"type":"result","subtype":"success","is_error":false,"permission_denials":[],"result":"denied","session_id":"'\$SID'"}'
else
  echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"'\$SID'"}'
fi
STUBEOF
chmod +x "$STUB"

echo "== positive: full pipeline + verifier"
QODER_BIN="$STUB" QODER_PROFILE_DIR="$PROF" DEST="$DEST" bash "$HERE/collect.sh" >/dev/null
cp "$HERE/collect.sh" "$HERE/verify.py" "$DEST/"
python3 "$HERE/verify.py" "$DEST"
echo "positive ok"

echo "== positive: same-generation rerun keeps current readable, no delete"
CUR_BEFORE=$(readlink "$DEST/current")
QODER_BIN="$STUB" QODER_PROFILE_DIR="$PROF" DEST="$DEST" bash "$HERE/collect.sh" >/dev/null
cp "$HERE/collect.sh" "$HERE/verify.py" "$DEST/"
[ "$(readlink "$DEST/current")" = "$CUR_BEFORE" ] || { echo "FAIL: generation changed on identical rerun"; exit 1; }
python3 "$HERE/verify.py" "$DEST" >/dev/null
echo "rerun ok"

echo "== positive: concurrent publishers do not corrupt generation (same + different generation)"
# 异代变体：builtin hook 名变化（断言不锁定该名字）→ 合法但内容不同的另一代
STUBF="$STUB" WORKD="$WORK" python3 <<'PY'
import os
s=open(os.environ['STUBF']).read()
old='"hook_name":"builtin"'
assert s.count(old)==1
p=os.path.join(os.environ['WORKD'],'stub-alt')
open(p,'w').write(s.replace(old,'"hook_name":"builtin2"'))
os.chmod(p,0o755)
PY
QODER_BIN="$STUB" QODER_PROFILE_DIR="$PROF" DEST="$DEST" bash "$HERE/collect.sh" >/dev/null 2>&1 &
P1=$!
QODER_BIN="$WORK/stub-alt" QODER_PROFILE_DIR="$PROF" DEST="$DEST" bash "$HERE/collect.sh" >/dev/null 2>&1 &
P2=$!
wait "$P1"; wait "$P2"
# 并发后不得存在嵌套 tmp 目录
find "$DEST" -maxdepth 2 -name '.tmpgen*' | grep . && { echo "FAIL: leftover temp dir"; exit 1; }
python3 "$HERE/verify.py" "$DEST" >/dev/null
CUR_NOW=$(readlink "$DEST/current"); [ -d "$DEST/$CUR_NOW" ] || { echo "FAIL: current dangling after race"; exit 1; }
echo "race ok (verifier green after concurrent same+diff generation publish)"

# neg: 断言具体错误类别（匹配 stderr 中的唯一诊断子串），不再只看非零退出
neg() { local label=$1 stub=$2 expect=$3; local rc=0 out
  local d="$WORK/dest-$label"; mkdir -p "$d"
  out=$(QODER_BIN="$stub" QODER_PROFILE_DIR="$PROF" DEST="$d" bash "$HERE/collect.sh" 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || { echo "FAIL: $label not rejected"; exit 1; }
  printf '%s' "$out" | grep -q "$expect" || { echo "FAIL: $label wrong diagnosis (want: $expect)"; printf '%s\n' "$out" | tail -2; exit 1; }
  echo "$label ok (exit $rc, matched: $expect)"; }

# 变异 stub：断言失败 / 多余工具面 / 错误路径 / 错误 tool_result id / 恶意 SID（python 字面量替换，锚点唯一）
STUBF="$STUB" WORKD="$WORK" python3 <<'PY'
import os
s=open(os.environ['STUBF']).read()
muts={
 'bad1': [('"result":"ok"', '"result":"nope"')],
 'bad2': [('TJ=\'["Read"]\'', 'TJ=\'["Bash","Read"]\'')],
 'bad3': [('"file_path":"\'$TF\'"', '"file_path":"/tmp/x/tool-input.txt"')],
 'bad4': [('"tool_use_id":"c2"', '"tool_use_id":"zz"')],
 'bad5': [('SID="11111111-2222-3333-4444-555555555555"',
          "SID=\"''') or 'aaaaaaaa' or re.fullmatch(r'.*','\"")],
 # 两端同删 ID：锁住原始 None==None 回归
 'bad6': [('"id":"c2"', '"id":null'), ('"tool_use_id":"c2"', '"tool_use_id":null')],
 # success 与 resume 全程无 session_id：提取器必须红
 'bad7': [('"result":"ok","session_id":"\'$SID\'"}', '"result":"ok"}'),
          ('"result":"You asked me to reply with exactly ok.","session_id":"\'$SID\'"}',
           '"result":"You asked me to reply with exactly ok."}')],
 # 攻击韧性正测变体：每次 invocation 尝试改写任意 policy + 写 HOME/tmp 绊线（应全被沙箱挡下）
 'stub-attack': [('if ! echo "$args" | grep -q \'setting-sources user\'; then',
   'for pp in /tmp/qoder-sbx.*/sandbox.sb; do echo "(allow default)" > "$pp" 2>/dev/null; done; touch /tmp/qoder-f317-escape 2>/dev/null; touch /var/tmp/qoder-f317-escape 2>/dev/null; touch "$HOME/.qoder-f317-escape" 2>/dev/null\nif ! echo "$args" | grep -q \'setting-sources user\'; then')],
 # clone 持久化污染：首个 invocation 往自己的 config dir 写 settings.json（必须被洁净审计拦下）
 'bad8': [('CFGDIR=$(echo "$args" | grep -oE \'config-dir [^ ]+\' | awk \'{print $2}\')',
           'CFGDIR=$(echo "$args" | grep -oE \'config-dir [^ ]+\' | awk \'{print $2}\')\necho "{}" > "$CFGDIR/settings.json" 2>/dev/null || true')],
}
for name,pairs in muts.items():
    for old,new in pairs:
        assert s.count(old)==1, f"{name}: anchor x{s.count(old)}: {old!r}"
        s=s.replace(old,new)
    pth=os.path.join(os.environ['WORKD'], name)
    open(pth,'w').write(s)
    os.chmod(pth,0o755)
    for old,new in pairs:  # 还原，供下一个变异基于原 stub
        s=s.replace(new,old)
PY

echo "== negative: assertion failure (wrong success output)"
neg bad-output "$WORK/bad1" 'success: FAILED'
echo "== negative: unexpected extra tool surface (tool-use exposes Bash)"
neg extra-tool "$WORK/bad2" 'tool-use: FAILED'
echo "== negative: wrong tool_use path (exact match enforced)"
neg wrong-path "$WORK/bad3" 'tool-use: FAILED'
echo "== negative: wrong tool_result id (pairing enforced)"
neg wrong-result-id "$WORK/bad4" 'permission-denial: FAILED'
echo "== negative: malicious session_id (source-injection rejected)"
neg malicious-sid "$WORK/bad5" 'bounded-charset validation'
echo "== negative: missing tool ids on BOTH ends (None pairing rejected)"
neg missing-ids "$WORK/bad6" 'permission-denial: FAILED'
echo "== negative: success/resume without session_id (extractor must fail)"
neg missing-sid "$WORK/bad7" 'session_id'

echo "== positive: attack resilience (policy rewrite + /tmp,/var/tmp,HOME escape attempts all blocked)"
snap_escape_set() { { ls "$HOME"/.qoder-f317-* /tmp/qoder-f317-* /var/tmp/qoder-f317-* 2>/dev/null || true; } | sort; }
BEFORE_ESC=$(snap_escape_set)
AD="$WORK/dest-attack"; mkdir -p "$AD"
QODER_BIN="$WORK/stub-attack" QODER_PROFILE_DIR="$PROF" DEST="$AD" bash "$HERE/collect.sh" >/dev/null 2>&1 \
  || { echo "FAIL: attack-resilient run rejected"; exit 1; }
cp "$HERE/collect.sh" "$HERE/verify.py" "$AD/"
python3 "$HERE/verify.py" "$AD" >/dev/null
AFTER_ESC=$(snap_escape_set)
[ "$BEFORE_ESC" = "$AFTER_ESC" ] || { echo "FAIL: escape marker set changed despite sandbox"; exit 1; }
echo "attack-resilience ok (policy intact, no new escape markers, verifier green)"

echo "== negative: clone persistence pollution (settings.json into config dir)"
neg clone-pollution "$WORK/bad8" 'clone cleanliness'

echo "== negative: dirty profile rejected (category)"
DIRTY="$WORK/dirty-profile"; mkdir -p "$DIRTY"; echo '{}' > "$DIRTY/settings.json"
rc=0; out=$(QODER_BIN="$STUB" QODER_PROFILE_DIR="$DIRTY" DEST="$DEST" bash "$HERE/collect.sh" 2>&1) || rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "profile not clean" || { echo "FAIL: dirty profile wrong diagnosis"; exit 1; }
echo "dirty-profile ok (exit 2)"

echo "== negative: missing profile rejected (category)"
rc=0; out=$(env -u QODER_PROFILE_DIR QODER_BIN="$STUB" DEST="$DEST" bash "$HERE/collect.sh" 2>&1) || rc=$?
[ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "QODER_PROFILE_DIR required" || { echo "FAIL: missing profile wrong diagnosis"; exit 1; }
echo "missing-profile ok (matched: QODER_PROFILE_DIR required)"

# verifier 负测：每个用例从独立干净代副本开始 + 断言具体 VERIFY FAIL 类别
fresh_gen() { local d="$WORK/vdest-$1"; rm -rf "$d"; mkdir -p "$d"
  cp "$HERE/collect.sh" "$HERE/verify.py" "$d/" 2>/dev/null
  GEN=$(readlink "$DEST/current")
  cp -R "$DEST/$GEN" "$d/$GEN"; ln -s "$GEN" "$d/current"; echo "$d"; }

vfail() { local label=$1 d=$2 expect=$3; local rc=0 out
  out=$(python3 "$HERE/verify.py" "$d" 2>&1) || rc=$?
  [ "$rc" -ne 0 ] || { echo "FAIL: $label not detected"; exit 1; }
  printf '%s' "$out" | grep -q "$expect" || { echo "FAIL: $label wrong diagnosis (want: $expect): $out"; exit 1; }
  echo "$label ok (matched: $expect)"; }

echo "== negative: tampered artifact detected (clean generation)"
D=$(fresh_gen tamper); GEN=$(readlink "$D/current"); printf 'x\n' >> "$D/$GEN/success.jsonl"
vfail tamper "$D" 'hash mismatch'

echo "== negative: extra file detected (clean generation)"
D=$(fresh_gen extra); GEN=$(readlink "$D/current"); : > "$D/$GEN/rogue.txt"
vfail extra-file "$D" 'extra/tampered files'

echo "== negative: missing side-effect receipt detected (clean generation)"
D=$(fresh_gen noside); GEN=$(readlink "$D/current"); rm "$D/$GEN/hook-red.side-effect"
vfail missing-side-effect "$D" 'missing side-effect receipt'

echo "== negative: false side-effect content detected (semantics enforced)"
D=$(fresh_gen falsereceipt); GEN=$(readlink "$D/current")
printf 'target_absent=false\n' > "$D/$GEN/permission-denial.side-effect"
python3 - "$D" "$GEN" <<'PY'
import sys,os,json,hashlib,shutil
d,gen=sys.argv[1],sys.argv[2]
gd=os.path.join(d,gen)
man=json.load(open(f"{gd}/generation.json"))
def sha(p): return hashlib.sha256(open(p,'rb').read()).hexdigest()
man["side_effects"]["permission-denial.side-effect"]=sha(f"{gd}/permission-denial.side-effect")
raw=json.dumps(man,indent=2).encode()
newgen=".gen-"+hashlib.sha256(raw).hexdigest()[:12]
open(f"{gd}/generation.json","wb").write(raw)
os.rename(gd, os.path.join(d,newgen))
os.symlink(newgen, os.path.join(d,"current.tmp")); os.replace(os.path.join(d,"current.tmp"), os.path.join(d,"current"))
PY
vfail false-receipt "$D" 'semantic mismatch'

echo "== negative: current escaping DEST detected"
D=$(fresh_gen escape); ln -sfn ../../outside "$D/current"
vfail symlink-escape "$D" 'not canonical'

echo "== negative: generation entry via alias symlink detected (non-canonical target)"
D=$(fresh_gen alias); GEN=$(readlink "$D/current")
ln -s "$GEN" "$D/.gen-alias"; ln -sfn .gen-alias "$D/current"
vfail gen-alias "$D" 'not canonical'

echo "== negative: canonical-named generation entry that is a symlink detected"
D=$(fresh_gen gensym); GEN=$(readlink "$D/current")
ln -s "$GEN" "$D/.gen-000000000000"; ln -sfn .gen-000000000000 "$D/current"
vfail gen-symlink "$D" 'generation entry is a symlink'

echo "== negative: generation entry via intermediate alias-dir detected"
D=$(fresh_gen aliasdir); GEN=$(readlink "$D/current")
ln -s . "$D/.alias-dir"; ln -sfn ".alias-dir/$GEN" "$D/current"
vfail gen-alias-dir "$D" 'current target not canonical'

echo "== negative: collector fingerprint mismatch detected"
D=$(fresh_gen csha); printf '\n# tampered\n' >> "$D/collect.sh"
vfail collector-mismatch "$D" 'collector identity mismatch'

echo "selftest PASS"
