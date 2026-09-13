#!/usr/bin/env bash
# F317 qoder golden fixtures 确定性采集脚本（L1 gate probe；会消耗 qoder credits）
# 硬前置：离线构建的干净 auth-only profile（QODER_PROFILE_DIR，含登录凭证、无 user settings/hooks/plugins）。
#   不接受默认回退到个人 ~/.qoder-cn —— 未显式传入即拒绝执行。
# 所有场景统一 strict deny-all MCP；逐场景断言精确 init.tools / init.mcp_servers（多余工具/服务器 = 红）。
# 全部断言通过后：唯一 temp 构建 → 校验 → 单 rename 发布整代 generation（含 stdout/stderr/exit/
#   assertion/side-effect 全量 sha256），current 指针以 temp+rename 切换；读方用 verify.py fail-closed 验证。
# 用法: QODER_BIN=~/.local/bin/qodercn QODER_PROFILE_DIR=<clean-profile> DEST=<repo>/packages/api/test/fixtures/qoder ./collect.sh
set -euo pipefail

QODER_BIN="${QODER_BIN:?QODER_BIN required}"
PROFILE="${QODER_PROFILE_DIR:?QODER_PROFILE_DIR required (clean auth-only profile; no fallback to personal config)}"
DEST="${DEST:-$(cd "$(dirname "$0")" && pwd)}"
mkdir -p "$DEST"; [ -w "$DEST" ] || { echo "DEST not writable: $DEST" >&2; exit 2; }
[ -d "$PROFILE" ] || { echo "profile dir not found: $PROFILE" >&2; exit 2; }
for banned in settings.json settings.local.json hooks plugins; do
  [ ! -e "$PROFILE/$banned" ] || { echo "profile not clean: contains $banned" >&2; exit 2; }
done
RAW=$(mktemp -d /tmp/qoder-collect.XXXXXX)
STAGE=$(mktemp -d /tmp/qoder-stage.XXXXXX)
trap 'rc=$?; if [ "$rc" -eq 0 ]; then rm -rf "$RAW" "$STAGE" "$SBXDIR"; else echo "FORENSIC: preserving $RAW $SBXDIR (STAGE=$STAGE cleaned)" >&2; rm -rf "$STAGE"; fi' EXIT

# OS 隔离硬门禁 v2：collector 自建 sandbox-exec 边界。
# - policy 放 SBXDIR（provider 沙箱内不可写），每次 invocation 前后校验哈希，篡改即红
# - 默认拒写面：HOME、/tmp、/private/tmp、/private/var/folders；唯一例外 RAW（规范化绝对路径）
# - 原始 PROFILE 永不给 provider：一次性 auth clone 落 RAW/auth，逐 run 丢弃
# - 行为级 canary：HOME 写必须被拒 / /tmp 写必须被拒 / RAW 写必须成功
# - 全程逃逸绊线：固定探测路径在任何时点出现文件即红
command -v sandbox-exec >/dev/null 2>&1 || { echo "ASSERTION FAIL: sandbox-exec unavailable, cannot establish isolation" >&2; exit 2; }
SBXDIR=$(mktemp -d /tmp/qoder-sbx.XXXXXX)
SBX_PROFILE="$SBXDIR/sandbox.sb"
RAWC=$(cd "$RAW" && pwd -P)   # seatbelt 按规范路径匹配，须消除 /tmp → /private/tmp 别名
cat > "$SBX_PROFILE" <<SBXEOF
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "$RAWC"))
SBXEOF
POLICY_FILE_SHA=$(python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$SBX_PROFILE")
check_policy_intact() {
  local now; now=$(python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$SBX_PROFILE")
  [ "$now" = "$POLICY_FILE_SHA" ] || { echo "ASSERTION FAIL: sandbox policy tampered between/inside invocations" >&2; exit 1; }
}
TRIPWIRES=("$HOME/.qoder-f317-escape-$$" "/tmp/qoder-f317-escape-$$" "/var/tmp/qoder-f317-escape-$$" "$PROFILE/.qoder-f317-escape-$$")
check_tripwires() {
  local t; for t in "${TRIPWIRES[@]}"; do [ ! -e "$t" ] || { echo "ASSERTION FAIL: escape tripwire hit: $t" >&2; exit 1; }; done
}
check_tripwires
CANARY_HOME="$HOME/.qoder-f317-canary-$$"; rm -f "$CANARY_HOME"; CANARY_TMP="/tmp/qoder-f317-canary-$$"; rm -f "$CANARY_TMP"
rc=0; sandbox-exec -f "$SBX_PROFILE" /bin/sh -c "touch '$CANARY_HOME'" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] && [ ! -e "$CANARY_HOME" ] || { echo "ASSERTION FAIL: sandbox canary: HOME write not blocked (rc=$rc)" >&2; exit 2; }
rc=0; sandbox-exec -f "$SBX_PROFILE" /bin/sh -c "touch '$CANARY_TMP'" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] && [ ! -e "$CANARY_TMP" ] || { echo "ASSERTION FAIL: sandbox canary: /tmp write not blocked (rc=$rc)" >&2; exit 2; }
CANARY_VTMP="/var/tmp/qoder-f317-canary-$$"; rm -f "$CANARY_VTMP"
rc=0; sandbox-exec -f "$SBX_PROFILE" /bin/sh -c "touch '$CANARY_VTMP'" 2>/dev/null || rc=$?
[ "$rc" -ne 0 ] && [ ! -e "$CANARY_VTMP" ] || { echo "ASSERTION FAIL: sandbox canary: /var/tmp write not blocked (rc=$rc)" >&2; exit 2; }
sandbox-exec -f "$SBX_PROFILE" /bin/sh -c "touch '$RAW/.canary-in'" || { echo "ASSERTION FAIL: sandbox canary: RAW write blocked" >&2; exit 2; }
[ -e "$RAW/.canary-in" ] || { echo "ASSERTION FAIL: sandbox canary: RAW marker missing" >&2; exit 2; }
rm -f "$RAW/.canary-in"
# 逐 invocation 一次性 auth clone：每场景从只读源新建，调用后审计洁净度并丢弃；
# 原始 PROFILE 不作为 --config-dir、也不进 child env。
fresh_auth() { AUTHD="$RAW/auth-$1"; rm -rf "$AUTHD"; mkdir -p "$AUTHD"
  cp -R "$PROFILE/.auth" "$AUTHD/" || { echo "ASSERTION FAIL: auth clone failed" >&2; exit 2; }; }
audit_auth() { # 精确攻击面审计（真实 provider 会对 config-dir 做正常初始化写入，见 L1 取证）：
  # 1) settings*.json 必须可解析且无非空 hooks 键（SessionStart hook = 任意命令执行入口）
  # 2) plugins 允许存在（qodercn 内置），但其中不得有可执行/脚本文件
  # 3) .auth 允许变化（token 自动刷新是预期行为）；原始 PROFILE 的不可达由沙箱 + tripwire 保证
  local d="$1" f bad
  for f in "$d"/settings.json "$d"/settings.local.json; do
    [ -e "$f" ] || continue
    python3 -c "
import json,sys
d=json.load(open('$f'))
h=d.get('hooks')
sys.exit(1 if h else 0)" || { echo "ASSERTION FAIL: clone cleanliness: non-empty hooks in $f" >&2; exit 1; }
  done
  bad=$( { find "$d/plugins" -type f \( -name '*.sh' -o -name '*.js' -o -name '*.py' -o -perm +111 \) 2>/dev/null || true; } )
  [ -z "$bad" ] || { echo "ASSERTION FAIL: clone cleanliness: executable/script in plugins: $bad" >&2; exit 1; }
  diff -r "$PROFILE/.auth" "$d/.auth" >/dev/null 2>&1 || echo "NOTE: clone .auth refreshed (token rotation, expected)" >&2
}

EXPECT="success tool-use permission-denial auth-error silent-model-fallback resume hook-red hook-green-project hook-green-local"
SANRAW="/tmp/qoder-collect.XXXXXX"   # sanitize() 对 RAW 的投影
DENY_MCP=(--strict-mcp-config --allowed-mcp-server-names nothing)

fail() { echo "ASSERTION FAIL: $*" >&2; exit 1; }

# 运行一个场景：stdout/stderr/exit 全部落 RAW；预期退出码显式断言（条件捕获，set -e 安全）
run() {
  local name=$1 expect_exit=$2; shift 2
  local rc=0
  check_policy_intact
  ( cd "${SCENARIO_CWD:-$RAW}" && env -u QODER_PROFILE_DIR -u QODER_BIN -u QODER_CONFIG_DIR sandbox-exec -f "$SBX_PROFILE" "$@" ) >"$RAW/$name.out" 2>"$RAW/$name.err" || rc=$?
  check_policy_intact; check_tripwires
  [ -n "${AUTHD:-}" ] && audit_auth "$AUTHD"
  echo "$rc" >"$RAW/$name.exit"
  [ "$rc" = "$expect_exit" ] || fail "$name: exit $rc, expected $expect_exit"
  sanitize <"$RAW/$name.out" >"$STAGE/$name.jsonl"
  sanitize <"$RAW/$name.err" >"$STAGE/$name.stderr.txt"
  cp "$RAW/$name.exit" "$STAGE/$name.exit"
}

sanitize() {
  sed -e "s#$HOME#~#g" -e 's#/private/tmp#/tmp#g' -e "s#$RAW#$SANRAW#g" -e "s#$PROFILE#<profile>#g"
}

# fail-closed 敏感扫描：HOME/PROFILE 原文、常见凭证形态、私钥、IP
scan() {
  local f=$1
  # sandbox receipt 自含 64 位 hex profile 指纹，base64 启发式对其豁免（其余子句全量适用）
  local base64_clause='|[A-Za-z0-9+/]{40,}={0,2}'
  case "$f" in */sandbox.side-effect) base64_clause='' ;; esac
  ! grep -qE "$HOME|$PROFILE|sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{8,}|(api[_-]?key|secret|token|password|cookie)['\"]?\s*[:=]$base64_clause|-----BEGIN [A-Z ]*PRIVATE KEY-----|([0-9]{1,3}\.){3}[0-9]{1,3}" "$f" \
    || fail "sensitive content in $(basename "$f")"
}

# JSONL 语义断言：只读 $STAGE/<name>.jsonl；断言表达式全部是脚本内静态字面量，
# 一切 provider 可控数据（expected_sid/toolfile/pwned）只经环境变量进 globals，绝不拼进代码字符串。
jassert() {
  local name=$1; shift
  STAGE_DIR="$STAGE" FIXTURE="$name" python3 - "$@" >"$STAGE/$name.assert" <<'PY' || { cat "$STAGE/$name.assert" >&2; exit 1; }
import json,sys,os
rows=[json.loads(l) for l in open(f"{os.environ['STAGE_DIR']}/{os.environ['FIXTURE']}.jsonl") if l.strip()]
name=os.environ['FIXTURE']
env={"rows":rows,
     "init":next((r for r in rows if r.get("subtype")=="init"),None),
     "result":[r for r in rows if r.get("type")=="result"][-1] if any(r.get("type")=="result" for r in rows) else None,
     "assistant":[r for r in rows if r.get("type")=="assistant"],
     # 完整投影：tool_use = (name, 全量 input 键值, id)；tool_result = (tool_use_id, is_error, content)
     "tus":[(b.get("name"), sorted((k,str(v)) for k,v in (b.get("input") or {}).items()), b.get("id"))
            for r in [r for r in rows if r.get("type")=="assistant"]
            for b in (r.get("message",{}).get("content") or []) if b.get("type")=="tool_use"],
     "trs":[(b.get("tool_use_id"), bool(b.get("is_error")), str(b.get("content")))
            for r in rows if r.get("type")=="user"
            for b in (r.get("message",{}).get("content") or []) if b.get("type")=="tool_result"],
     "toolfile":os.environ.get("TOOLFILE",""), "pwned":os.environ.get("PWNEDPATH",""),
     "expected_sid":os.environ.get("EXPECTED_SID",""),
     # id 配对前置门：tool_use/tool_result 的 id 必须都是非空字符串（None==None 不算配对）
     "ids_nonempty":(
        all(isinstance(b.get("id"),str) and len(b["id"])>0
            for r in [r for r in rows if r.get("type")=="assistant"]
            for b in (r.get("message",{}).get("content") or []) if b.get("type")=="tool_use")
        and all(isinstance(b.get("tool_use_id"),str) and len(b["tool_use_id"])>0
            for r in rows if r.get("type")=="user"
            for b in (r.get("message",{}).get("content") or []) if b.get("type")=="tool_result"))}
safety={"any":any,"all":all,"str":str,"int":int,"len":len,"sorted":sorted,"bool":bool,"True":True,"False":False,"None":None}
for c in sys.argv[1:]:
    ok=False
    try: ok=eval(c, {"__builtins__":{}, **safety, **env})
    except Exception as e: print(f"{name}: check error {c}: {e}"); sys.exit(1)
    if ok is not True: print(f"{name}: FAILED {c}"); sys.exit(1)
print(f"{name}: ok")
PY
  echo "expressions:" >> "$STAGE/$name.assert"
  printf '%s\n' "$@" >> "$STAGE/$name.assert"
}

# ---- fixture: success（空工具 + deny-all MCP）----
SCENARIO_CWD=$RAW
fresh_auth success; run success 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$AUTHD" "${DENY_MCP[@]}" --tools "" --setting-sources user
jassert success \
  'init is not None' 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' \
  'init.get("permissionMode")=="default"' 'init.get("model")=="Auto"' \
  'result.get("result")=="ok"' 'result.get("is_error") is False' \
  'rows[0].get("subtype")=="hook_started"' 'tus==[]' 'trs==[]'

# ---- fixture: tool-use（确定性输入文件；仅 Read；工具调用全集严格全等；Read 行号协议规范化）----
TOOLFILE_RAW="$RAW/tool-input.txt"; printf 'F317-DETERMINISTIC-LINE-1\n' > "$TOOLFILE_RAW"
fresh_auth tool-use; run tool-use 0 "$QODER_BIN" -p "Read the file $TOOLFILE_RAW and reply with its exact content." \
  -o stream-json --config-dir "$AUTHD" "${DENY_MCP[@]}" --tools "Read" --setting-sources user
export TOOLFILE="$(printf '%s' "$TOOLFILE_RAW" | sanitize)"
jassert tool-use \
  'sorted(init.get("tools") or [])==["Read"]' 'init.get("mcp_servers")==[]' \
  'ids_nonempty' 'len(tus)==1 and tus[0][0]=="Read" and tus[0][1]==[("file_path",toolfile)]' \
  'len(trs)==1 and trs[0][0]==tus[0][2] and trs[0][1]==False and trs[0][2].splitlines()[0].split("\t",1)[-1]=="F317-DETERMINISTIC-LINE-1"' \
  '"F317-DETERMINISTIC-LINE-1" in str(result.get("result",""))' 'result.get("is_error") is False'
unset TOOLFILE

# ---- fixture: permission-denial（唯一临时目标；仅 Write；工具调用全集严格全等）----
PWNED_RAW="$RAW/pwned.txt"; rm -f "$PWNED_RAW"
fresh_auth permission-denial; run permission-denial 0 "$QODER_BIN" -p "Use the Write tool to create $PWNED_RAW with content 'x'. Do it now, do not ask." \
  -o stream-json --config-dir "$AUTHD" "${DENY_MCP[@]}" --tools "Write" --setting-sources user
[ ! -e "$PWNED_RAW" ] || fail "permission-denial: target file was written"
echo "target_absent=true" > "$STAGE/permission-denial.side-effect"
export PWNEDPATH="$(printf '%s' "$PWNED_RAW" | sanitize)"
jassert permission-denial \
  'sorted(init.get("tools") or [])==["Write"]' 'init.get("mcp_servers")==[]' \
  'ids_nonempty' 'len(tus)==1 and tus[0][0]=="Write" and tus[0][1]==[("content","x"),("file_path",pwned)]' \
  'len(trs)==1 and trs[0][0]==tus[0][2] and trs[0][1]==True and "Error: Allow" in trs[0][2]' \
  'result.get("is_error") is False'
unset PWNEDPATH

# ---- fixture: auth-error（空 config dir，预期 exit 1）----
AUTHD=""   # auth-error 用独立空目录，不持 clone；reset 防止审计落在上一场景的陈旧 clone
EMPTY=$(mktemp -d "$RAW/empty.XXXXXX")
run auth-error 1 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$EMPTY" "${DENY_MCP[@]}" --tools ""
jassert auth-error 'init is not None' 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' \
  'result.get("is_error") is True' 'result.get("subtype")=="success"' 'tus==[]' 'trs==[]'

# ---- fixture: silent-model-fallback（空工具）----
fresh_auth silent-model-fallback; run silent-model-fallback 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$AUTHD" "${DENY_MCP[@]}" -m definitely-not-a-model-xyz --tools "" --setting-sources user
jassert silent-model-fallback 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' \
  'init.get("model")=="Auto"' 'result.get("is_error") is False' 'tus==[]' 'trs==[]'

# ---- fixture: resume（空工具；SID 经 stdin 传入做有界校验——provider 字节绝不进任何源码字符串）----
# 协议事实（L1 实测）：qodercn 把 session 存在 config-dir 的 projects/<cwd-slug>/ 下，
# resume 必须同 config-dir + 同 cwd。因此 resume 复用 success 的 clone（仍在 RAW 内，审计照常）。
AUTHD="$RAW/auth-success"
SID=$(python3 - "$STAGE/success.jsonl" <<'SIDPY' || fail "resume: session_id failed bounded-charset validation"
import json,re,sys
sids=set()
for line in open(sys.argv[1]):
    if not line.strip(): continue
    d=json.loads(line)
    sid=d.get("session_id")
    if sid is None: continue
    if not (isinstance(sid,str) and re.fullmatch(r"[A-Za-z0-9-]{8,64}", sid)):
        sys.exit(1)
    sids.add(sid)
# success 中必须存在 SID，且所有出现值唯一（空集/多值都是协议异常）
if len(sids)!=1:
    sys.stderr.write(f"sid set invalid: {len(sids)} distinct\n")
    sys.exit(1)
print(sids.pop())
SIDPY
) || fail "resume: session_id extraction failed"
export EXPECTED_SID="$SID"
run resume 0 "$QODER_BIN" -r "$SID" -p "In one short sentence: what did I ask you in the previous turn?" \
  -o stream-json --config-dir "$AUTHD" "${DENY_MCP[@]}" --tools "" --setting-sources user
jassert resume 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' \
  'result.get("session_id")==expected_sid' 'result.get("is_error") is False' \
  '"reply with exactly" in str(result.get("result","")).lower() and "ok" in str(result.get("result","")).lower()' \
  'tus==[]' 'trs==[]'
unset EXPECTED_SID

# ---- fixtures: S5 hook 红→绿（独立 project/marker；空工具 + deny-all MCP）----
mkproj() { local d; d=$(mktemp -d "$RAW/proj.XXXXXX"); mkdir -p "$d/.qoder"; echo "$d"; }

P1D=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P1D"'/marker"}]}]}}' > "$P1D/.qoder/settings.json"
SCENARIO_CWD=$P1D
fresh_auth hook-red; run hook-red 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json --config-dir "$AUTHD" "${DENY_MCP[@]}" --tools ""
[ -e "$P1D/marker" ] || fail "hook-red: malicious hook did NOT run (expected red)"
echo "marker_present=true" > "$STAGE/hook-red.side-effect"
jassert hook-red 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' 'tus==[]' 'trs==[]' \
  'any(r.get("subtype")=="hook_started" and "marker" in str(r.get("hook_name","")) for r in rows)'

P2D=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P2D"'/marker"}]}]}}' > "$P2D/.qoder/settings.json"
SCENARIO_CWD=$P2D
fresh_auth hook-green-project; run hook-green-project 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$AUTHD" "${DENY_MCP[@]}" --tools "" --setting-sources user
[ ! -e "$P2D/marker" ] || fail "hook-green-project: marker exists (block failed)"
echo "marker_absent=true" > "$STAGE/hook-green-project.side-effect"
jassert hook-green-project 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' 'tus==[]' 'trs==[]' \
  'not any("marker" in str(r.get("hook_name","")) for r in rows if r.get("subtype")=="hook_started")'

P3D=$(mkproj); echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch '"$P3D"'/marker"}]}]}}' > "$P3D/.qoder/settings.local.json"
SCENARIO_CWD=$P3D
fresh_auth hook-green-local; run hook-green-local 0 "$QODER_BIN" -p "reply with exactly: ok" -o stream-json \
  --config-dir "$AUTHD" "${DENY_MCP[@]}" --tools "" --setting-sources user
[ ! -e "$P3D/marker" ] || fail "hook-green-local: marker exists (block failed)"
echo "marker_absent=true" > "$STAGE/hook-green-local.side-effect"
jassert hook-green-local 'sorted(init.get("tools") or [])==[]' 'init.get("mcp_servers")==[]' 'tus==[]' 'trs==[]' \
  'not any("marker" in str(r.get("hook_name","")) for r in rows if r.get("subtype")=="hook_started")'

# ---- 发布前：最终完整性（policy 未被篡改 + 绊线干净）+ sandbox receipt 入 STAGE ----
check_policy_intact; check_tripwires
{
  echo "fs_restricted: true"
  echo "method: macOS-sandbox-exec-allowlist"
  echo "profile_sha256: $(sanitize < "$SBX_PROFILE" | python3 -c "import hashlib,sys;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())")"
  echo "canary_home_blocked: true"
  echo "canary_tmp_blocked: true"
  echo "canary_var_tmp_blocked: true"
  echo "auth_clone_per_invocation: true"
  echo "canary_raw_allowed: true"
  echo "policy_location: outside-provider-writable-scope"
  echo "bound_run_dir: $(printf '%s' "$RAW" | sanitize)"
} > "$STAGE/sandbox.side-effect"
for f in "$STAGE"/*; do scan "$f"; done
for name in $EXPECT; do
  for suf in jsonl stderr.txt exit assert; do [ -f "$STAGE/$name.$suf" ] || fail "missing artifact $name.$suf"; done
done
ACTUAL=$(cd "$STAGE" && ls *.jsonl | sed 's/\.jsonl//' | sort)
[ "$ACTUAL" = "$(echo $EXPECT | tr ' ' '\n' | sort)" ] || fail "stale/extra fixtures in staging: $ACTUAL"

CSHA=$(python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$0")
python3 - "$STAGE" "$EXPECT" "$CSHA" > "$STAGE/generation.json" <<'PY'
import json,sys,hashlib,glob,os
stage,expect,csha=sys.argv[1],sys.argv[2].split(),sys.argv[3]
def sha(p): return hashlib.sha256(open(p,'rb').read()).hexdigest()
artifacts={}
for n in expect:
    artifacts[n]={s:sha(f"{stage}/{n}.{s}") for s in ("jsonl","stderr.txt","exit","assert")}
side_effects={os.path.basename(p):sha(p) for p in sorted(glob.glob(f"{stage}/*.side-effect"))}
print(json.dumps({"schema":"qoder-f317-generation/3","collector":"collect.sh","collector_sha256":csha,
  "expect":expect,"artifacts":artifacts,"side_effects":side_effects},indent=2))
PY

# ---- 原子发布（单一 python 步骤）：flock 互斥 → CAS rename 提交 → 校验复用 → os.replace 切指针 ----
python3 - "$STAGE" "$DEST" <<'PY' || fail "publish failed"
import os,sys,hashlib,shutil,fcntl,filecmp
stage,dest=sys.argv[1],sys.argv[2]
gen_bytes=open(f"{stage}/generation.json","rb").read()
genhash=hashlib.sha256(gen_bytes).hexdigest()[:12]
genid=f".gen-{genhash}"; target=os.path.join(dest,genid)
with open(os.path.join(dest,".publish.lock"),"w") as lf:
    fcntl.flock(lf,fcntl.LOCK_EX)
    if os.path.lexists(target):
        # 同代已存在：绝不删除，逐文件字节比对后复用
        a=sorted(os.listdir(stage)); b=sorted(os.listdir(target))
        if a!=b or any(open(os.path.join(stage,f),'rb').read()!=open(os.path.join(target,f),'rb').read() for f in a):
            print(f"content mismatch for existing {genid}"); sys.exit(1)
    else:
        tmp=os.path.join(dest,f".tmpgen.{os.getpid()}.{genhash}")
        shutil.rmtree(tmp,ignore_errors=True)
        shutil.copytree(stage,tmp,symlinks=False)
        try:
            os.rename(tmp,target)          # CAS：target 已存在则抛 OSError
        except OSError:
            shutil.rmtree(tmp,ignore_errors=True)  # 并发对端已提交；走上面的复用路径重试一次
            if not os.path.isdir(target): print("rename lost race without target"); sys.exit(1)
            a=sorted(os.listdir(stage)); b=sorted(os.listdir(target))
            if a!=b or any(open(os.path.join(stage,f),'rb').read()!=open(os.path.join(target,f),'rb').read() for f in a):
                print(f"content mismatch for racing {genid}"); sys.exit(1)
    tmplink=os.path.join(dest,f".current.{os.getpid()}")
    if os.path.lexists(tmplink): os.remove(tmplink)
    os.symlink(genid,tmplink)
    os.replace(tmplink,os.path.join(dest,"current"))
print(f"published generation {genhash}")
PY
echo "published: $EXPECT"
