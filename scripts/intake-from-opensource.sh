#!/usr/bin/env bash
# intake-from-opensource.sh — Clowder AI → Clowder AI 社区贡献吸收
#
# Usage: see --help or run without args. V1: plan + record only (apply = V2).
# Design consensus (2026-03-13): no bidirectional sync, no reverse transform,
# intake by PR, 3-class: safe-cherry-pick / manual-port / public-only.

set -euo pipefail

# ── 颜色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ── 路径 ──
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$SOURCE_DIR/../clowder-ai"
INTAKE_LEDGER="$SOURCE_DIR/docs/ops/opensource-intake-ledger.json"
TARGET_REPO="zts212653/clowder-ai"
SOURCE_REPO="zts212653/cat-cafe"

resolve_target_main_head() {
  if git -C "$TARGET_DIR" remote get-url origin >/dev/null 2>&1; then
    if git -C "$TARGET_DIR" fetch origin main --quiet >/dev/null 2>&1; then
      if git -C "$TARGET_DIR" rev-parse --verify refs/remotes/origin/main >/dev/null 2>&1; then
        git -C "$TARGET_DIR" rev-parse refs/remotes/origin/main 2>/dev/null
        return 0
      fi
    fi
  fi

  git -C "$TARGET_DIR" rev-parse HEAD 2>/dev/null
}

# ── 参数 ──
PR_NUMBER=""
MODE="plan"
ADVANCE_LEDGER=false
FORCE_OVERWRITE=false
RECORD_DECISION=false
DECISION=""
VALIDATE_INBOUND=false
FROM_INDEX=false
INTENT_ISSUE=""
ABSORB_PR=""
REVIEW_PROOF=""
SKIP_ABSORBED_GUARD=false
VERIFY_MERGE_READY=false

for arg in "$@"; do
  case "$arg" in
    --pr=*) PR_NUMBER="${arg#--pr=}" ;;
    --pr) ;; # handled below with next arg
    --mode=*) MODE="${arg#--mode=}" ;;
    --decision=*) DECISION="${arg#--decision=}" ;;
    --intent-issue=*) INTENT_ISSUE="${arg#--intent-issue=}" ;;
    --absorb-pr=*) ABSORB_PR="${arg#--absorb-pr=}" ;;
    --review-proof=*) REVIEW_PROOF="${arg#--review-proof=}" ;;
    --advance-ledger) ADVANCE_LEDGER=true ;;
    --force-overwrite) FORCE_OVERWRITE=true ;;
    --skip-absorbed-guard) SKIP_ABSORBED_GUARD=true ;;
    --verify-merge-ready) VERIFY_MERGE_READY=true ;;
    --record) RECORD_DECISION=true ;;
    --validate-inbound) VALIDATE_INBOUND=true ;;
    --from-index) FROM_INDEX=true ;;
  esac
done
# Handle space-separated args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr) PR_NUMBER="$2"; shift 2 ;;
    --decision) DECISION="$2"; shift 2 ;;
    --intent-issue) INTENT_ISSUE="$2"; shift 2 ;;
    --absorb-pr) ABSORB_PR="$2"; shift 2 ;;
    --review-proof) REVIEW_PROOF="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# ── Path classification ──
# Files that are COMPLETELY REPLACED during outbound sync (never absorb)
is_public_only() {
  local path="$1"
  case "$path" in
    .github/FUNDING.yml|.github/ISSUE_TEMPLATE/*|.github/DISCUSSION_TEMPLATE/*) return 0 ;;
    CHANGELOG.md|docs/community/*) return 0 ;;
    # Generated/replaced files
    CONTRIBUTING.md|SETUP.md|LICENSE|.env.example) return 0 ;;
    .github/pull_request_template.md) return 0 ;;
    CLAUDE.md|AGENTS.md|GEMINI.md) return 0 ;;
    cat-config.json) return 0 ;;
    docs/ROADMAP.md|docs/public-lessons.md|docs/README.md) return 0 ;;
    .sync-provenance.json) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Dictionary-driven path classification (F238 Phase C) ──
# Single source of truth: assets/brand-dictionary.yaml
# Helper: scripts/brand-dictionary-helper.mjs provides CLI + module interface.
#
# Classify a path via the dictionary helper.  Returns the inbound classification
# from path_policies (manual-port / brand-sensitive / public-only / safe-cherry-pick).
classify_path() {
  local path="$1"
  local result
  # Fail-closed: if the helper is unavailable, default to manual-port (not safe-cherry-pick).
  # This ensures P0/P1 paths are never silently downgraded when the helper or js-yaml is missing.
  result=$(node "$SOURCE_DIR/scripts/brand-dictionary-helper.mjs" --classify-path "$path" 2>/dev/null || echo '{"classification":"manual-port","risk":"P1","reason":"helper unavailable — fail-closed"}')
  echo "$result" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(d.classification)"
}

is_manual_port() {
  local path="$1"
  local cls
  cls=$(classify_path "$path")
  [ "$cls" = "manual-port" ]
}

# Everything else = safe to cherry-pick (only cosmetic sanitization applied)
# packages/api/**, packages/web/**, packages/shared/**, packages/mcp-server/**

# ── Brand-sensitive files (Inbound Guard) ──
# Dictionary-driven + legacy fallback for paths not yet in dictionary.
# Legacy patterns will be migrated to brand-dictionary.yaml in a follow-up.
BRAND_SENSITIVE_LEGACY=(
  "packages/web/src/app/layout.tsx"
  "packages/web/src/components/SplitPaneView.tsx"
  "packages/web/src/components/ChatContainerHeader.tsx"
  "packages/web/src/utils/api-client.ts"
)

is_brand_sensitive() {
  local path="$1"
  # Dictionary first
  local cls
  cls=$(classify_path "$path")
  if [ "$cls" = "brand-sensitive" ]; then return 0; fi
  # Legacy fallback
  for pattern in "${BRAND_SENSITIVE_LEGACY[@]}"; do
    if [ "$path" = "$pattern" ]; then return 0; fi
  done
  # Icon files
  case "$path" in
    packages/web/public/icons/*) return 0 ;;
  esac
  return 1
}

# ── High-risk files (Intake Guard) ──
# These files often carry route wiring, dependency injection, auth/callback,
# env, allowlist, or sync behavior. They may still be mechanically mergeable,
# but plan mode must not classify them as plain safe-cherry-pick.
HIGH_RISK_PATTERNS=(
  "packages/api/src/index.ts"
  "packages/api/src/routes/*.ts"
  "*/route-*.ts"
  "packages/api/src/config/env-registry.ts"
  "packages/api/src/infrastructure/telemetry/metric-allowlist.ts"
  "*callback*.ts"
  "*auth*.ts"
  "scripts/intake-from-opensource.sh"
  "scripts/sync-*.sh"
)

is_high_risk() {
  local path="$1"
  local pattern
  for pattern in "${HIGH_RISK_PATTERNS[@]}"; do
    case "$path" in
      $pattern) return 0 ;;
    esac
  done
  return 1
}

# ── Brand Expectations (single source of truth) ──
# Format: file|check_type|pattern|description
# check_type: must_not_contain, must_contain, file_exists
# Both --validate-inbound and pre-commit hook consume this list.
BRAND_EXPECTATIONS=(
  # layout.tsx
  "packages/web/src/app/layout.tsx|must_not_contain|Clowder AI|title should be Clowder AI"
  "packages/web/src/app/layout.tsx|must_not_contain|Your AI team collaboration space|description should be Chinese"
  "packages/web/src/app/layout.tsx|must_contain|favicon.svg|favicon declaration required"
  "packages/web/src/app/layout.tsx|must_contain|icon-192x192.png|PWA icon declaration required"
  # SplitPaneView.tsx
  "packages/web/src/components/SplitPaneView.tsx|must_not_contain|Clowder AI|brand should be Clowder AI"
  # manifest.json
  "packages/web/public/manifest.json|must_not_contain|Clowder|name should be Clowder AI"
  # ChatContainerHeader.tsx — surface text AND semantic fields
  "packages/web/src/components/ChatContainerHeader.tsx|must_not_contain|Clowder AI|brand should be Clowder AI"
  "packages/web/src/components/ChatContainerHeader.tsx|must_contain|Cat Caf|must have Clowder AI brand"
  "packages/web/src/components/ChatContainerHeader.tsx|must_contain|'cat-cafe'|INTERNAL_BASENAMES must include cat-cafe"
  "packages/web/src/components/ChatContainerHeader.tsx|must_contain|'cat-cafe-runtime'|INTERNAL_BASENAMES must include cat-cafe-runtime"
  # api-client.ts — comment AND real brand identity (F156: header → session cookie)
  "packages/web/src/utils/api-client.ts|must_not_contain|client for Clowder AI|comment should reference Clowder AI"
  "packages/web/src/utils/api-client.ts|must_contain|HttpOnly session cookie|identity uses session cookie (F156 D-1)"
  # connector command deep links — home runtime fallback must stay on 3001; public sync transforms it to 3003.
  "packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts|must_not_contain|http://localhost:3003|connector command fallback should use Clowder AI frontend port"
  "packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts|must_contain|http://localhost:3003|connector command fallback should use Clowder AI frontend port"
  # favicon.svg file
  "packages/web/public/icons/favicon.svg|file_exists||favicon SVG must exist"
)

# ── Validate Inbound (Brand Guard) ──
# Checks files for brand contamination from clowder-ai.
# --from-index: read staged (index) content instead of working tree.
#   This is critical for pre-commit hooks where index and worktree may differ.
_BRAND_VIOLATION_COUNT=0

# Index-aware file helpers
_brand_file_exists() {
  if [ "$FROM_INDEX" = true ]; then
    git ls-files --stage -- "$1" 2>/dev/null | grep -q .
  else
    [ -f "$1" ]
  fi
}

_brand_file_contains() {
  local file="$1" pattern="$2"
  if [ "$FROM_INDEX" = true ]; then
    git show :"$file" 2>/dev/null | grep -q "$pattern"
  else
    grep -q "$pattern" "$file" 2>/dev/null
  fi
}

run_brand_validation() {
  _BRAND_VIOLATION_COUNT=0
  # ── Phase 1: Legacy BRAND_EXPECTATIONS (specific must_contain/must_not_contain rules) ──
  for expectation in "${BRAND_EXPECTATIONS[@]}"; do
    IFS='|' read -r file check_type pattern desc <<< "$expectation"
    case "$check_type" in
      must_not_contain)
        if _brand_file_exists "$file" && _brand_file_contains "$file" "$pattern"; then
          echo -e "${RED}  ✗ $file: contains '$pattern' ($desc)${NC}"
          _BRAND_VIOLATION_COUNT=$((_BRAND_VIOLATION_COUNT + 1))
        fi
        ;;
      must_contain)
        if _brand_file_exists "$file" && ! _brand_file_contains "$file" "$pattern"; then
          echo -e "${RED}  ✗ $file: missing '$pattern' ($desc)${NC}"
          _BRAND_VIOLATION_COUNT=$((_BRAND_VIOLATION_COUNT + 1))
        fi
        ;;
      file_exists)
        if ! _brand_file_exists "$file"; then
          echo -e "${RED}  ✗ $file: file missing ($desc)${NC}"
          _BRAND_VIOLATION_COUNT=$((_BRAND_VIOLATION_COUNT + 1))
        fi
        ;;
    esac
  done

  # ── Phase 2: Dictionary-driven public-term contamination scan (F238 Phase C) ──
  # For every brand-protected file (brand-sensitive OR manual-port from dictionary),
  # check that it does not contain public-side P1 brand terms. Both classifications
  # need guarding — manual-port paths are often the highest-risk (P0 system prompts).
  # Fail-closed: smoke-test ALL subcommand categories before trusting output.
  # If helper doesn't exist, skip Phase 2 (legacy Phase 1 still runs).
  local public_terms_json=""
  if [ -f "$SOURCE_DIR/scripts/brand-dictionary-helper.mjs" ]; then
    # Category 1: --classify-path (classification pipeline)
    local _smoke _smoke_cls
    _smoke=$(node "$SOURCE_DIR/scripts/brand-dictionary-helper.mjs" --classify-path "assets/system-prompts/x" 2>/dev/null) || _smoke=""
    _smoke_cls=$(echo "$_smoke" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));console.log(d.classification)}catch{console.log('BROKEN')}" 2>/dev/null) || _smoke_cls="BROKEN"
    if [ "$_smoke_cls" != "manual-port" ]; then
      echo -e "${RED}  ✗ Dictionary helper broken (classify) — Phase 2 fail-closed${NC}"
      _BRAND_VIOLATION_COUNT=$((_BRAND_VIOLATION_COUNT + 1))
      return
    fi
    # Category 2: --public-terms (JSON term data)
    public_terms_json=$(node "$SOURCE_DIR/scripts/brand-dictionary-helper.mjs" --public-terms 2>/dev/null) || public_terms_json=""
    local _pt_count
    _pt_count=$(echo "$public_terms_json" | node -e "try{const t=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));console.log(t.length)}catch{console.log(0)}" 2>/dev/null) || _pt_count=0
    if [ "$_pt_count" -lt 1 ] 2>/dev/null; then
      echo -e "${RED}  ✗ Dictionary helper broken (--public-terms returned empty/garbage) — Phase 2 fail-closed${NC}"
      _BRAND_VIOLATION_COUNT=$((_BRAND_VIOLATION_COUNT + 1))
      return
    fi
    # Category 3: --manual-port-patterns (glob lists — validated below after fetch)
  fi
  if [ -n "$public_terms_json" ]; then
    # Extract P1 public brand patterns (one per line)
    local public_p1_patterns
    public_p1_patterns=$(echo "$public_terms_json" | node -e "
      const terms = JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
      for (const t of terms) {
        if (t.severity === 'P1' && t.termClass === 'brand') {
          for (const p of t.publicPatterns) console.log(p);
        }
      }
    " 2>/dev/null) || public_p1_patterns=""

    if [ -n "$public_p1_patterns" ]; then
      # Get list of brand-protected globs from dictionary (both classifications)
      local bs_raw mp_raw
      bs_raw=$(node "$SOURCE_DIR/scripts/brand-dictionary-helper.mjs" --brand-sensitive-patterns 2>/dev/null) || bs_raw=""
      mp_raw=$(node "$SOURCE_DIR/scripts/brand-dictionary-helper.mjs" --manual-port-patterns 2>/dev/null) || mp_raw=""
      # Category 3 cross-validation: verify pattern output matches THREE known anchors
      # from different glob families. A correct-subset that hits some but drops others fails.
      _glob_to_re() { echo "$1" | sed 's/\./\\./g; s/\*\*/__GLOBSTAR__/g; s/\*/[^\/]*/g; s/__GLOBSTAR__/.*/g'; }
      local _bs_anchors=("packages/web/public/manifest.json" "packages/web/public/icons/logo.png" "packages/web/public/concierge/skins/ragdoll-v1/pet.json")
      for _anchor in "${_bs_anchors[@]}"; do
        local _bs_hit=""
        while IFS= read -r pat; do
          [ -z "$pat" ] && continue
          if echo "$_anchor" | grep -qE "^$(_glob_to_re "$pat")$"; then
            _bs_hit="yes"; break
          fi
        done <<< "$bs_raw"
        if [ -z "$_bs_hit" ]; then
          echo -e "${RED}  ✗ Dictionary helper broken (--brand-sensitive-patterns misses anchor: $_anchor) — fail-closed${NC}"
          _BRAND_VIOLATION_COUNT=$((_BRAND_VIOLATION_COUNT + 1))
          return
        fi
      done
      while IFS= read -r pat; do
        [ -z "$pat" ] && continue
        if echo "assets/system-prompts/test.md" | grep -qE "^$(_glob_to_re "$pat")$"; then
          _mp_match="yes"; break
        fi
      done <<< "$mp_raw"
      if [ -z "$_mp_match" ]; then
        echo -e "${RED}  ✗ Dictionary helper broken (--manual-port-patterns doesn't match known anchor) — fail-closed${NC}"
        _BRAND_VIOLATION_COUNT=$((_BRAND_VIOLATION_COUNT + 1))
        return
      fi
      local bs_patterns
      bs_patterns=$(printf '%s\n%s' "$bs_raw" "$mp_raw" | sort -u)

      if [ -n "$bs_patterns" ]; then
        # Build a list of existing files matching brand-sensitive patterns
        local bs_files=""
        while IFS= read -r glob_pat; do
          [ -z "$glob_pat" ] && continue
          if [ "$FROM_INDEX" = true ]; then
            # Match staged files against glob using the dictionary helper's classify
            local staged_files
            staged_files=$(git diff --cached --name-only 2>/dev/null || true)
            while IFS= read -r sf; do
              [ -z "$sf" ] && continue
              local sf_cls
              sf_cls=$(node "$SOURCE_DIR/scripts/brand-dictionary-helper.mjs" --classify-path "$sf" 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(d.classification)" 2>/dev/null || true)
              if [ "$sf_cls" = "brand-sensitive" ] || [ "$sf_cls" = "manual-port" ]; then
                bs_files="${bs_files}${sf}\n"
              fi
            done <<< "$staged_files"
          else
            # Working tree: find files matching patterns
            local found
            found=$(find . -path "./$glob_pat" -type f 2>/dev/null | sed 's|^\./||' || true)
            bs_files="${bs_files}${found}\n"
          fi
        done <<< "$bs_patterns"

        # Deduplicate and check each file
        local checked_files=""
        while IFS= read -r bsf; do
          [ -z "$bsf" ] && continue
          # Skip files already checked by BRAND_EXPECTATIONS (avoid double-counting)
          if echo "${BRAND_EXPECTATIONS[*]}" | grep -q "^${bsf}|"; then continue; fi
          # Skip brand-validation toolchain files — they reference brand terms as
          # detection constants, not as content that needs sanitization.
          case "$bsf" in
            scripts/intake-from-opensource.sh|scripts/brand-dictionary-helper.mjs|scripts/brand-dictionary-helper.test.mjs) continue ;;
          esac
          # Skip already-checked files (dedup)
          if echo "$checked_files" | grep -qF "$bsf"; then continue; fi
          checked_files="${checked_files}${bsf}\n"

          while IFS= read -r pub_term; do
            [ -z "$pub_term" ] && continue
            if _brand_file_exists "$bsf" && _brand_file_contains "$bsf" "$pub_term"; then
              echo -e "${RED}  ✗ $bsf: contains public brand term '$pub_term' (dictionary-driven)${NC}"
              _BRAND_VIOLATION_COUNT=$((_BRAND_VIOLATION_COUNT + 1))
            fi
          done <<< "$public_p1_patterns"
        done <<< "$(echo -e "$bs_files")"
      fi
    fi
  fi
}

review_proof_contains_head() {
  local content="$1"
  local head_full="$2"
  local head_short="$3"

  if echo "$content" | grep -qi "$head_full"; then return 0; fi
  if echo "$content" | grep -qi "$head_short"; then return 0; fi
  return 1
}

validate_review_proof_continuity() {
  local absorb_pr_head="$1"
  local review_proof_mode="$2"
  local absorb_pr_head_short="${absorb_pr_head:0:8}"

  if [ "$review_proof_mode" = "file" ]; then
    if review_proof_contains_head "$(cat "$REVIEW_PROOF" 2>/dev/null || true)" "$absorb_pr_head" "$absorb_pr_head_short"; then
      return 0
    fi
    echo -e "${RED}✗ --review-proof file must mention absorb PR current HEAD ($absorb_pr_head_short)${NC}"
    return 1
  fi

  local expected_prefix="https://github.com/${SOURCE_REPO}/pull/${ABSORB_PR}"
  if [[ "$REVIEW_PROOF" != "$expected_prefix"* ]]; then
    echo -e "${RED}✗ --review-proof URL must point to absorb PR #$ABSORB_PR (${SOURCE_REPO})${NC}"
    return 1
  fi

  local proof_json=""
  local proof_body=""
  local proof_commit=""
  local proof_kind=""
  local proof_id=""

  if [[ "$REVIEW_PROOF" =~ \#issuecomment-([0-9]+)$ ]]; then
    proof_kind="issuecomment"
    proof_id="${BASH_REMATCH[1]}"
    proof_json=$(gh api "repos/$SOURCE_REPO/issues/comments/$proof_id" 2>/dev/null || true)
    if [ -z "$proof_json" ]; then
      echo -e "${RED}✗ Cannot fetch review-proof issue comment #$proof_id from $SOURCE_REPO${NC}"
      return 1
    fi
    proof_body=$(echo "$proof_json" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.body||''))")
  elif [[ "$REVIEW_PROOF" =~ \#pullrequestreview-([0-9]+)$ ]]; then
    proof_kind="pullrequestreview"
    proof_id="${BASH_REMATCH[1]}"
    proof_json=$(gh api "repos/$SOURCE_REPO/pulls/$ABSORB_PR/reviews/$proof_id" 2>/dev/null || true)
    if [ -z "$proof_json" ]; then
      echo -e "${RED}✗ Cannot fetch review-proof pull request review #$proof_id from $SOURCE_REPO${NC}"
      return 1
    fi
    proof_body=$(echo "$proof_json" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.body||''))")
    proof_commit=$(echo "$proof_json" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.commit_id||''))")
  elif [[ "$REVIEW_PROOF" =~ \#discussion_r([0-9]+)$ ]]; then
    proof_kind="discussion"
    proof_id="${BASH_REMATCH[1]}"
    proof_json=$(gh api "repos/$SOURCE_REPO/pulls/comments/$proof_id" 2>/dev/null || true)
    if [ -z "$proof_json" ]; then
      echo -e "${RED}✗ Cannot fetch review-proof inline comment #$proof_id from $SOURCE_REPO${NC}"
      return 1
    fi
    proof_body=$(echo "$proof_json" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.body||''))")
    proof_commit=$(echo "$proof_json" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.commit_id||''))")
  else
    echo -e "${RED}✗ --review-proof URL must include #issuecomment-*, #pullrequestreview-*, or #discussion_r*${NC}"
    echo "  This guard must verify review evidence against absorb PR current HEAD."
    return 1
  fi

  if [ -n "$proof_commit" ] && [ "$proof_commit" = "$absorb_pr_head" ]; then
    return 0
  fi

  if review_proof_contains_head "$proof_body" "$absorb_pr_head" "$absorb_pr_head_short"; then
    return 0
  fi

  echo -e "${RED}✗ review-proof ($proof_kind:$proof_id) does not cover absorb PR current HEAD $absorb_pr_head_short${NC}"
  echo "  Ask reviewer to explicitly extend pass to current HEAD, then use that URL as --review-proof."
  return 1
}

run_absorbed_record_guard() {
  if [ "$SKIP_ABSORBED_GUARD" = true ]; then
    echo -e "${YELLOW}⚠ --skip-absorbed-guard enabled: bypassing absorbed intake strict guard${NC}"
    return 0
  fi

  if [ -z "$INTENT_ISSUE" ]; then
    echo -e "${RED}✗ absorbed record requires --intent-issue <cat-cafe issue number>${NC}"
    return 1
  fi
  if [ -z "$ABSORB_PR" ]; then
    echo -e "${RED}✗ absorbed record requires --absorb-pr <cat-cafe PR number>${NC}"
    return 1
  fi
  if [ -z "$REVIEW_PROOF" ]; then
    echo -e "${RED}✗ absorbed record requires --review-proof <GitHub review URL or local proof file>${NC}"
    return 1
  fi
  if ! [[ "$INTENT_ISSUE" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}✗ --intent-issue must be a numeric GitHub issue id${NC}"
    return 1
  fi
  if ! [[ "$ABSORB_PR" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}✗ --absorb-pr must be a numeric GitHub PR id${NC}"
    return 1
  fi

  local review_proof_mode="url"
  if [[ "$REVIEW_PROOF" =~ ^https?:// ]]; then
    if ! [[ "$REVIEW_PROOF" =~ github\.com/ ]]; then
      echo -e "${RED}✗ --review-proof URL must point to GitHub evidence${NC}"
      return 1
    fi
  elif [ -f "$REVIEW_PROOF" ]; then
    review_proof_mode="file"
  else
    echo -e "${RED}✗ --review-proof must be a GitHub URL or an existing local file path${NC}"
    return 1
  fi

  local intent_info
  intent_info=$(gh issue view "$INTENT_ISSUE" --repo "$SOURCE_REPO" --json state,stateReason,labels,body,url,title 2>/dev/null || true)
  if [ -z "$intent_info" ]; then
    echo -e "${RED}✗ Cannot fetch Intake Intent Issue #$INTENT_ISSUE from $SOURCE_REPO${NC}"
    return 1
  fi

  local issue_state
  local issue_state_reason
  local issue_is_closed=false
  issue_state=$(echo "$intent_info" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(d.state||'')")
  issue_state_reason=$(echo "$intent_info" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(d.stateReason||'')")
  if [ "$issue_state" = "OPEN" ]; then
    issue_is_closed=false
  elif [ "$issue_state" = "CLOSED" ]; then
    issue_is_closed=true
    if [ "$issue_state_reason" = "NOT_PLANNED" ]; then
      echo -e "${RED}✗ Intake Intent Issue #$INTENT_ISSUE is CLOSED as NOT_PLANNED; cannot use as absorbed proof${NC}"
      echo "  If this is historical backfill or outbound-filed hotfix, rerun with --skip-absorbed-guard"
      return 1
    fi
  else
    echo -e "${RED}✗ Intake Intent Issue #$INTENT_ISSUE is $issue_state (expected OPEN or CLOSED)${NC}"
    echo "  If this is historical backfill or outbound-filed hotfix, rerun with --skip-absorbed-guard"
    return 1
  fi

  local issue_label_ok
  issue_label_ok=$(echo "$intent_info" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); const labels=(d.labels||[]).map(l=>String(l.name||'').toLowerCase()); console.log(labels.includes('intake') ? 'yes' : 'no')")
  if [ "$issue_label_ok" != "yes" ]; then
    echo -e "${RED}✗ Intake Intent Issue #$INTENT_ISSUE is missing required label: intake${NC}"
    return 1
  fi

  local issue_table_ok
  issue_table_ok=$(echo "$intent_info" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); const body=String(d.body||''); const hasHeader=/##\\s*逐文件决策表/.test(body); const hasRow=/\\|\\s*[^|\\n]+\\s*\\|\\s*[^|\\n]+\\s*\\|\\s*(absorb|skip)\\b/i.test(body); console.log(hasHeader && hasRow ? 'yes' : 'no')")
  if [ "$issue_table_ok" != "yes" ]; then
    echo -e "${RED}✗ Intake Intent Issue #$INTENT_ISSUE is missing a valid per-file decision table${NC}"
    return 1
  fi

  local issue_source_ref_ok
  issue_source_ref_ok=$(echo "$intent_info" | SOURCE_PR="$PR_NUMBER" node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); const body=String(d.body||''); const n=process.env.SOURCE_PR; const ok=body.includes('clowder-ai#'+n) || body.includes('zts212653/clowder-ai/pull/'+n); console.log(ok ? 'yes' : 'no')")
  if [ "$issue_source_ref_ok" != "yes" ]; then
    echo -e "${RED}✗ Intake Intent Issue #$INTENT_ISSUE must reference source PR clowder-ai#$PR_NUMBER${NC}"
    return 1
  fi

  local absorb_pr_info
  absorb_pr_info=$(gh pr view "$ABSORB_PR" --repo "$SOURCE_REPO" --json state,body,url,title,headRefOid 2>/dev/null || true)
  if [ -z "$absorb_pr_info" ]; then
    echo -e "${RED}✗ Cannot fetch absorb PR #$ABSORB_PR from $SOURCE_REPO${NC}"
    return 1
  fi

  local absorb_pr_state
  absorb_pr_state=$(echo "$absorb_pr_info" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(d.state||'')")
  if [ "$absorb_pr_state" != "OPEN" ] && [ "$absorb_pr_state" != "MERGED" ]; then
    echo -e "${RED}✗ Absorb PR #$ABSORB_PR is $absorb_pr_state (expected OPEN or MERGED)${NC}"
    return 1
  fi
  if [ "$issue_is_closed" = true ] && [ "$absorb_pr_state" != "MERGED" ]; then
    echo -e "${RED}✗ Intake Intent Issue #$INTENT_ISSUE is CLOSED, so absorb PR #$ABSORB_PR must be MERGED${NC}"
    echo "  Closed issue + open absorb PR indicates a broken intake chain."
    return 1
  fi

  local absorb_pr_head
  absorb_pr_head=$(echo "$absorb_pr_info" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.headRefOid||''))")
  if [ -z "$absorb_pr_head" ]; then
    echo -e "${RED}✗ Cannot resolve absorb PR #$ABSORB_PR headRefOid${NC}"
    return 1
  fi

  local absorb_pr_closes_ok
  absorb_pr_closes_ok=$(echo "$absorb_pr_info" | INTENT_ISSUE_ID="$INTENT_ISSUE" node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); const body=String(d.body||''); const i=process.env.INTENT_ISSUE_ID; const re=new RegExp('Closes\\\\s+(?:cat-cafe#|#)'+i+'\\\\b','i'); console.log(re.test(body) ? 'yes' : 'no')")
  if [ "$absorb_pr_closes_ok" != "yes" ]; then
    echo -e "${RED}✗ Absorb PR #$ABSORB_PR body must contain: Closes #$INTENT_ISSUE${NC}"
    return 1
  fi

  local absorb_pr_source_ref_ok
  absorb_pr_source_ref_ok=$(echo "$absorb_pr_info" | SOURCE_PR="$PR_NUMBER" node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); const body=String(d.body||''); const n=process.env.SOURCE_PR; const ok=body.includes('clowder-ai#'+n) || body.includes('zts212653/clowder-ai/pull/'+n); console.log(ok ? 'yes' : 'no')")
  if [ "$absorb_pr_source_ref_ok" != "yes" ]; then
    echo -e "${RED}✗ Absorb PR #$ABSORB_PR body must reference source PR clowder-ai#$PR_NUMBER${NC}"
    return 1
  fi

  validate_review_proof_continuity "$absorb_pr_head" "$review_proof_mode" || return 1

  echo -e "${GREEN}✓ Absorbed intake strict guard passed.${NC}"
  echo "  intent issue: #$INTENT_ISSUE ($issue_state)"
  echo "  absorb PR:    #$ABSORB_PR ($absorb_pr_state)"
  echo "  review head:  ${absorb_pr_head:0:8}"
  echo "  review proof: $REVIEW_PROOF ($review_proof_mode)"
  return 0
}

if [ "$VALIDATE_INBOUND" = true ]; then
  echo -e "${GREEN}=== 🛡 Inbound Brand Guard ===${NC}"
  echo ""
  run_brand_validation
  if [ "$_BRAND_VIOLATION_COUNT" -gt 0 ]; then
    echo ""
    echo -e "${RED}✗ Found $_BRAND_VIOLATION_COUNT brand violation(s)!${NC}"
    echo "  These files contain clowder-ai brand strings that should be cat-cafe values."
    echo "  Fix them before committing. See SKILL.md principle 12-13 for reference values."
    exit 1
  else
    echo -e "${GREEN}✓ No brand violations detected. Safe to commit.${NC}"
    exit 0
  fi
fi

# ── Record decision (happy path) ──
# Records a per-PR decision in entries[]. Does NOT advance last_reviewed_target_head.
# Use --advance-ledger after recording all PRs to advance the gate.
if [ "$RECORD_DECISION" = true ]; then
  if [ -z "$PR_NUMBER" ]; then
    echo -e "${RED}✗ --record requires --pr <number>${NC}"; exit 1
  fi
  if [ -z "$DECISION" ]; then
    echo -e "${RED}✗ --record requires --decision <absorbed|public-only|rejected>${NC}"; exit 1
  fi
  # P2 fix: mandatory Brand Guard before recording absorbed intake
  if [ "$DECISION" = "absorbed" ]; then
    echo -e "${BLUE}── Mandatory Brand Guard (pre-record) ──${NC}"
    run_brand_validation
    if [ "$_BRAND_VIOLATION_COUNT" -gt 0 ]; then
      echo ""
      echo -e "${RED}✗ $_BRAND_VIOLATION_COUNT brand violation(s) detected. Fix before recording absorbed intake.${NC}"
      echo "  Run: bash scripts/intake-from-opensource.sh --validate-inbound  (for details)"
      exit 1
    fi
    echo -e "${GREEN}✓ Brand Guard passed.${NC}"
    echo ""
    echo -e "${BLUE}── Mandatory Intake Strict Guard (pre-record) ──${NC}"
    run_absorbed_record_guard || exit 1
    echo ""
  fi
  case "$DECISION" in
    absorbed|public-only|rejected|outbound-sync) ;;
    *) echo -e "${RED}✗ Invalid decision '$DECISION'. Use: absorbed | public-only | rejected | outbound-sync${NC}"; exit 1 ;;
  esac
  if [ ! -f "$INTAKE_LEDGER" ]; then
    echo -e "${RED}✗ Intake ledger not found${NC}"; exit 1
  fi
  PR_MERGE_INFO=$(gh pr view "$PR_NUMBER" --repo "$TARGET_REPO" --json state,mergeCommit 2>/dev/null || true)
  if [ -z "$PR_MERGE_INFO" ]; then
    echo -e "${RED}✗ Cannot fetch PR #$PR_NUMBER from $TARGET_REPO${NC}"; exit 1
  fi
  PR_REC_STATE=$(echo "$PR_MERGE_INFO" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(d.state)")
  if [ "$PR_REC_STATE" != "MERGED" ]; then
    echo -e "${RED}✗ PR #$PR_NUMBER is $PR_REC_STATE, not MERGED.${NC}"; exit 1
  fi
  PR_MERGE_SHA=$(echo "$PR_MERGE_INFO" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log((d.mergeCommit||{}).oid||'')")
  PR_NUMBER_ENV="$PR_NUMBER" \
  PR_MERGE_SHA_ENV="$PR_MERGE_SHA" \
  DECISION_ENV="$DECISION" \
  INTENT_ISSUE_ENV="$INTENT_ISSUE" \
  ABSORB_PR_ENV="$ABSORB_PR" \
  REVIEW_PROOF_ENV="$REVIEW_PROOF" \
  SKIP_ABSORBED_GUARD_ENV="$SKIP_ABSORBED_GUARD" \
  node -e "
    const fs = require('fs');
    const prNumber = Number(process.env.PR_NUMBER_ENV || '0');
    const decision = process.env.DECISION_ENV || '';
    const ledger = JSON.parse(fs.readFileSync('$INTAKE_LEDGER', 'utf-8'));
    if (ledger.entries.some(e => e.pr_number === prNumber && e.action !== 'force_advance')) {
      console.log('⚠ PR #' + prNumber + ' already recorded. Skipping.'); process.exit(0);
    }
    const entry = {
      pr_number: prNumber,
      target_merge_commit: process.env.PR_MERGE_SHA_ENV || '',
      decision,
      timestamp: new Date().toISOString(),
    };
    if (decision === 'absorbed') {
      const skip = (process.env.SKIP_ABSORBED_GUARD_ENV || '').toLowerCase() === 'true';
      const intentIssue = Number(process.env.INTENT_ISSUE_ENV || '0');
      const absorbPr = Number(process.env.ABSORB_PR_ENV || '0');
      const reviewProof = process.env.REVIEW_PROOF_ENV || '';
      if (skip) {
        entry.note = 'absorbed record created with --skip-absorbed-guard (outbound-filed hotfix or historical backfill)';
        if (intentIssue > 0) entry.intake_intent_issue = intentIssue;
        if (absorbPr > 0) entry.absorb_pr = absorbPr;
        if (reviewProof) entry.review_proof = reviewProof;
      } else {
        entry.intake_intent_issue = intentIssue;
        entry.absorb_pr = absorbPr;
        entry.review_proof = reviewProof;
      }
    }
    ledger.entries.push(entry);
    fs.writeFileSync('$INTAKE_LEDGER', JSON.stringify(ledger, null, 2) + '\n');
    const mergeShort = (process.env.PR_MERGE_SHA_ENV || '').slice(0, 12);
    console.log('✓ Recorded PR #' + prNumber + ' → ' + decision + ' (merge: ' + mergeShort + ')');
  "
  # Auto-attempt advance-ledger after successful record
  echo ""
  echo -e "${BLUE}── Auto-attempting ledger advance ──${NC}"
  bash "$0" --advance-ledger
  _advance_rc=$?
  if [ $_advance_rc -eq 0 ] && [ -n "$ABSORB_PR" ]; then
    echo ""
    echo -e "${BLUE}── Post-record continuity advisory ──${NC}"
    echo "  Review proof was validated against absorb PR HEAD at record time."
    echo "  After committing the ledger update, the absorb PR HEAD will advance."
    echo -e "  Before merging, run:"
    echo -e "    ${GREEN}bash scripts/intake-from-opensource.sh --verify-merge-ready --absorb-pr $ABSORB_PR${NC}"
    echo "  This verifies the post-review delta is ledger-only (non-behavioral)."
  fi
  exit $_advance_rc
fi

# ── Advance ledger ──
if [ "$ADVANCE_LEDGER" = true ]; then
  if [ ! -d "$TARGET_DIR/.git" ]; then
    echo -e "${RED}✗ Target repo not found at $TARGET_DIR${NC}"
    exit 1
  fi
  CURRENT_HEAD=$(resolve_target_main_head)
  if [ ! -f "$INTAKE_LEDGER" ]; then
    echo -e "${RED}✗ Intake ledger not found at $INTAKE_LEDGER${NC}"
    exit 1
  fi
  OLD_HEAD=$(node -e "const l=JSON.parse(require('fs').readFileSync('$INTAKE_LEDGER','utf-8')); console.log(l.last_reviewed_target_head || '')" 2>/dev/null || true)
  if [ "$OLD_HEAD" = "$CURRENT_HEAD" ]; then
    echo -e "${GREEN}✓ Ledger already at target HEAD ($CURRENT_HEAD)${NC}"
    exit 0
  fi
  # Enumerate landed non-sync commits on the target repo mainline (first-parent only).
  # A long community PR may merge multiple branch commits under one recorded merge commit;
  # those child commits should not block advance-ledger.
  UNREVIEWED=""
  UNREVIEWED_COUNT=0
  if [ -n "$OLD_HEAD" ]; then
    # Build set of recorded merge commits from entries[]
    RECORDED_SHAS=$(node -e "const l=JSON.parse(require('fs').readFileSync('$INTAKE_LEDGER','utf-8')); l.entries.filter(e=>e.target_merge_commit).forEach(e=>console.log(e.target_merge_commit))" 2>/dev/null || true)
    for c in $(git -C "$TARGET_DIR" rev-list --first-parent "$OLD_HEAD".."$CURRENT_HEAD" 2>/dev/null); do
      MSG=$(git -C "$TARGET_DIR" log --format=%s -1 "$c" 2>/dev/null || true)
      if echo "$MSG" | grep -qE "^sync:.*(cat-cafe|clowder-ai|v[0-9]+\.[0-9]+|outbound)"; then continue; fi
      # Check if this landed mainline commit is covered by an entries[] record
      if echo "$RECORDED_SHAS" | grep -q "^${c}$"; then continue; fi
      UNREVIEWED_COUNT=$((UNREVIEWED_COUNT + 1))
      SHORT=$(git -C "$TARGET_DIR" log --format="%h %s" -1 "$c" 2>/dev/null)
      UNREVIEWED="${UNREVIEWED}    → ${SHORT}\n"
    done
  fi
  if [ "$UNREVIEWED_COUNT" -gt 0 ]; then
    echo -e "${RED}✗ Cannot advance: $UNREVIEWED_COUNT unrecorded non-sync commit(s)${NC}"
    echo -e "$UNREVIEWED"
    echo ""
    echo "  For each community PR, run:"
    echo "    bash scripts/intake-from-opensource.sh --pr <N> --mode=plan"
    echo "    bash scripts/intake-from-opensource.sh --record --pr <N> --decision <absorbed|public-only|rejected|outbound-sync>"
    echo "      (absorbed requires --intent-issue <I> --absorb-pr <P> --review-proof <URL|file>)"
    echo "      review-proof must explicitly cover absorb PR current HEAD SHA"
    echo ""
    echo "  Or force-advance (DANGEROUS — skips per-PR review):"
    echo "    bash scripts/intake-from-opensource.sh --advance-ledger --force-overwrite"
    if [ "$FORCE_OVERWRITE" != true ]; then
      exit 1
    fi
    echo -e "${YELLOW}⚠ --force-overwrite: force-advancing ledger${NC}"
    # Record forced advance in entries for audit
    node -e "
      const fs = require('fs');
      const ledger = JSON.parse(fs.readFileSync('$INTAKE_LEDGER', 'utf-8'));
      ledger.entries.push({
        action: 'force_advance',
        from: '$OLD_HEAD',
        to: '$CURRENT_HEAD',
        skipped_community_commits: $UNREVIEWED_COUNT,
        timestamp: new Date().toISOString(),
        notes: 'Force-advanced without per-PR review'
      });
      ledger.last_reviewed_target_head = '$CURRENT_HEAD';
      fs.writeFileSync('$INTAKE_LEDGER', JSON.stringify(ledger, null, 2) + '\n');
      console.log('⚠ Ledger force-advanced to: $CURRENT_HEAD');
    "
    exit 0
  fi
  # No unreviewed commits — safe to auto-advance
  node -e "
    const fs = require('fs');
    const ledger = JSON.parse(fs.readFileSync('$INTAKE_LEDGER', 'utf-8'));
    ledger.last_reviewed_target_head = '$CURRENT_HEAD';
    fs.writeFileSync('$INTAKE_LEDGER', JSON.stringify(ledger, null, 2) + '\n');
    console.log('✓ Ledger advanced to: $CURRENT_HEAD (only sync commits since last review)');
  "
  exit 0
fi

# ── Verify merge readiness (post-record continuity check) ──
if [ "$VERIFY_MERGE_READY" = true ]; then
  if [ -z "$ABSORB_PR" ]; then
    echo -e "${RED}✗ --verify-merge-ready requires --absorb-pr <number>${NC}"; exit 1
  fi

  echo -e "${GREEN}=== 🔍 Post-Record Merge Readiness Check ===${NC}"
  echo ""

  absorb_info=$(gh pr view "$ABSORB_PR" --repo "$SOURCE_REPO" --json headRefOid,state,headRefName 2>/dev/null || true)
  if [ -z "$absorb_info" ]; then
    echo -e "${RED}✗ Cannot fetch absorb PR #$ABSORB_PR from $SOURCE_REPO${NC}"; exit 1
  fi

  vmr_current_head=$(echo "$absorb_info" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.headRefOid||''))")
  vmr_pr_state=$(echo "$absorb_info" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.state||''))")
  vmr_branch=$(echo "$absorb_info" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.headRefName||''))")

  if [ "$vmr_pr_state" = "MERGED" ]; then
    echo -e "${GREEN}✓ Absorb PR #$ABSORB_PR is already MERGED. No pre-merge check needed.${NC}"
    exit 0
  fi
  if [ "$vmr_pr_state" != "OPEN" ]; then
    echo -e "${RED}✗ Absorb PR #$ABSORB_PR is $vmr_pr_state (expected OPEN or MERGED)${NC}"; exit 1
  fi

  vmr_proof_url="$REVIEW_PROOF"
  if [ -z "$vmr_proof_url" ]; then
    vmr_proof_url=$(ABSORB_PR_NUM="$ABSORB_PR" node -e "
      const fs = require('fs');
      const l = JSON.parse(fs.readFileSync('$INTAKE_LEDGER', 'utf-8'));
      const n = Number(process.env.ABSORB_PR_NUM);
      const entry = [...l.entries].reverse().find(e => e.absorb_pr === n);
      console.log(String(entry?.review_proof || ''));
    " 2>/dev/null || true)
  fi
  if [ -z "$vmr_proof_url" ]; then
    echo -e "${RED}✗ No review proof found. Provide --review-proof <URL> or ensure ledger has a recorded entry.${NC}"
    exit 1
  fi

  vmr_proof_commit=""
  if [[ "$vmr_proof_url" =~ \#pullrequestreview-([0-9]+)$ ]]; then
    vmr_proof_json=$(gh api "repos/$SOURCE_REPO/pulls/$ABSORB_PR/reviews/${BASH_REMATCH[1]}" 2>/dev/null || true)
    if [ -n "$vmr_proof_json" ]; then
      vmr_proof_commit=$(echo "$vmr_proof_json" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.commit_id||''))")
    fi
  elif [[ "$vmr_proof_url" =~ \#discussion_r([0-9]+)$ ]]; then
    vmr_proof_json=$(gh api "repos/$SOURCE_REPO/pulls/comments/${BASH_REMATCH[1]}" 2>/dev/null || true)
    if [ -n "$vmr_proof_json" ]; then
      vmr_proof_commit=$(echo "$vmr_proof_json" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.commit_id||''))")
    fi
  elif [[ "$vmr_proof_url" =~ \#issuecomment-([0-9]+)$ ]]; then
    vmr_proof_json=$(gh api "repos/$SOURCE_REPO/issues/comments/${BASH_REMATCH[1]}" 2>/dev/null || true)
    if [ -n "$vmr_proof_json" ]; then
      vmr_proof_body=$(echo "$vmr_proof_json" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(String(d.body||''))")
      vmr_proof_commit=$(echo "$vmr_proof_body" | grep -oE '[0-9a-f]{40}' | head -1 || true)
      if [ -z "$vmr_proof_commit" ]; then
        vmr_proof_commit=$(echo "$vmr_proof_body" | grep -oE '[0-9a-f]{7,12}' | head -1 || true)
      fi
    fi
  elif [ -f "$vmr_proof_url" ]; then
    vmr_proof_commit=$(grep -oE '[0-9a-f]{40}' "$vmr_proof_url" | head -1 || true)
  fi

  if [ -z "$vmr_proof_commit" ]; then
    echo -e "${YELLOW}⚠ Could not extract proof commit SHA from review proof.${NC}"
    echo "  Review proof: $vmr_proof_url"
    echo "  Cannot verify continuity automatically. Manual check required."
    exit 1
  fi

  echo "  Absorb PR:     #$ABSORB_PR ($vmr_pr_state)"
  echo "  Review proof:  ${vmr_proof_commit:0:8}"
  echo "  Current HEAD:  ${vmr_current_head:0:8}"

  if [ "$vmr_proof_commit" = "$vmr_current_head" ]; then
    echo ""
    echo -e "${GREEN}✓ Merge ready: current HEAD matches review proof exactly.${NC}"
    exit 0
  fi

  echo ""
  echo "  HEAD advanced since review. Checking delta..."

  git fetch origin "$vmr_branch" --quiet 2>/dev/null || true

  vmr_delta_files=$(git diff --name-only "$vmr_proof_commit".."$vmr_current_head" 2>/dev/null || true)
  if [ -z "$vmr_delta_files" ]; then
    echo -e "${GREEN}✓ Merge ready: no file changes between review proof and current HEAD.${NC}"
    exit 0
  fi

  vmr_has_behavioral=false
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      docs/ops/opensource-intake-ledger.json) ;;
      docs/mailbox/*) ;;
      *) vmr_has_behavioral=true ;;
    esac
  done <<< "$vmr_delta_files"

  if [ "$vmr_has_behavioral" = false ]; then
    echo -e "${GREEN}✓ Merge ready: post-review delta is non-behavioral (ledger/mailbox only).${NC}"
    echo "  Delta files:"
    echo "$vmr_delta_files" | sed 's/^/    /'
    exit 0
  else
    echo -e "${RED}✗ Post-review delta contains behavioral changes:${NC}"
    echo "$vmr_delta_files" | sed 's/^/    /'
    echo ""
    echo "  Ask reviewer to extend review to current HEAD (${vmr_current_head:0:8}),"
    echo "  then re-run this check."
    exit 1
  fi
fi

# ── Plan mode ──
if [ -z "$PR_NUMBER" ]; then
  echo "Usage:"
  echo "  bash scripts/intake-from-opensource.sh --pr <N> --mode=plan              # Analyze PR"
  echo "  bash scripts/intake-from-opensource.sh --record --pr <N> --decision <D>  # Record decision"
  echo "    absorbed (default lane) requires: --intent-issue <I> --absorb-pr <P> --review-proof <URL|file>"
  echo "      review-proof must cover absorb PR current HEAD (comment/review URL or file with SHA)"
  echo "    optional override: --skip-absorbed-guard  (direct-main historical backfill or outbound-filed hotfix)"
  echo "      override may omit issue / absorb PR / review-proof; do not invent placeholder fields"
  echo "  bash scripts/intake-from-opensource.sh --advance-ledger                  # Advance ledger (sync-only commits)"
  echo "  bash scripts/intake-from-opensource.sh --verify-merge-ready --absorb-pr <P> [--review-proof <URL>]"
  echo "                                                                            # Post-record continuity check"
  echo "  bash scripts/intake-from-opensource.sh --validate-inbound                # 🛡 Check brand contamination (working tree)"
  echo "  bash scripts/intake-from-opensource.sh --validate-inbound --from-index   # 🛡 Check brand contamination (staged/index)"
  echo ""
  echo "Decisions: absorbed | public-only | rejected | outbound-sync"
  exit 1
fi

echo -e "${GREEN}=== Clowder AI → Clowder AI Intake ===${NC}"
echo "PR: #$PR_NUMBER"
echo "Mode: $MODE"
echo ""

# Fetch PR info
PR_INFO=$(gh pr view "$PR_NUMBER" --repo "$TARGET_REPO" --json title,state,author,mergedAt,mergeCommit 2>/dev/null || true)
if [ -z "$PR_INFO" ]; then
  echo -e "${RED}✗ Cannot fetch PR #$PR_NUMBER from $TARGET_REPO${NC}"
  exit 1
fi

PR_TITLE=$(echo "$PR_INFO" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(d.title)")
PR_STATE=$(echo "$PR_INFO" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(d.state)")
PR_AUTHOR=$(echo "$PR_INFO" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(d.author.login)")
PR_MERGED=$(echo "$PR_INFO" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')); console.log(d.mergedAt || 'not merged')")

echo -e "${BLUE}Title:${NC}  $PR_TITLE"
echo -e "${BLUE}Author:${NC} $PR_AUTHOR"
echo -e "${BLUE}State:${NC}  $PR_STATE"
echo -e "${BLUE}Merged:${NC} $PR_MERGED"
echo ""

# P1-2: Block plan on unmerged PRs — intake operates on landed facts, not candidates
if [ "$PR_STATE" != "MERGED" ]; then
  echo -e "${RED}✗ PR #$PR_NUMBER is $PR_STATE, not MERGED.${NC}"
  echo "  Intake operates on PRs that have landed in clowder-ai main."
  echo "  Merge the PR first, then re-run intake."
  exit 1
fi

# Get changed files.
# `gh pr view --json files` only returns the first page for large PRs; use
# the REST files endpoint with pagination so the intake table cannot silently
# miss files beyond the first 100.
FILES=$(gh api --paginate "repos/$TARGET_REPO/pulls/$PR_NUMBER/files" --jq '.[].filename' 2>/dev/null || true)

if [ -z "$FILES" ]; then
  echo -e "${YELLOW}⚠ No files found in PR (may not be merged yet)${NC}"
  echo "  Intake works best with merged PRs."
  exit 0
fi

# Classify files
SAFE_FILES=""
SAFE_COUNT=0
MANUAL_FILES=""
MANUAL_COUNT=0
PUBLIC_FILES=""
PUBLIC_COUNT=0
BRAND_FILES=""
BRAND_COUNT=0
HIGH_RISK_FILES=""
HIGH_RISK_COUNT=0

while IFS= read -r file; do
  [ -z "$file" ] && continue
  if is_public_only "$file"; then
    PUBLIC_FILES="${PUBLIC_FILES}  ${file}\n"
    PUBLIC_COUNT=$((PUBLIC_COUNT + 1))
  elif is_brand_sensitive "$file"; then
    BRAND_FILES="${BRAND_FILES}  ${file}\n"
    BRAND_COUNT=$((BRAND_COUNT + 1))
  elif is_high_risk "$file"; then
    HIGH_RISK_FILES="${HIGH_RISK_FILES}  ${file}\n"
    HIGH_RISK_COUNT=$((HIGH_RISK_COUNT + 1))
  elif is_manual_port "$file"; then
    MANUAL_FILES="${MANUAL_FILES}  ${file}\n"
    MANUAL_COUNT=$((MANUAL_COUNT + 1))
  else
    SAFE_FILES="${SAFE_FILES}  ${file}\n"
    SAFE_COUNT=$((SAFE_COUNT + 1))
  fi
done <<< "$FILES"

# Report
echo -e "${GREEN}── Intake Classification ──${NC}"
echo ""

if [ "$SAFE_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✓ safe-cherry-pick ($SAFE_COUNT files)${NC} — can absorb directly"
  echo -e "$SAFE_FILES"
fi

if [ "$BRAND_COUNT" -gt 0 ]; then
  echo -e "${RED}🛡 BRAND GUARD ($BRAND_COUNT files)${NC} — contains brand identity, DO NOT cherry-pick directly!"
  echo -e "$BRAND_FILES"
  echo -e "  ${YELLOW}→ Must diff-merge manually: take logic changes, keep cat-cafe brand values${NC}"
  echo -e "  ${YELLOW}→ After merge, run: bash scripts/intake-from-opensource.sh --validate-inbound${NC}"
  echo ""
fi

if [ "$HIGH_RISK_COUNT" -gt 0 ]; then
  echo -e "${RED}⚠ HIGH-RISK GUARD ($HIGH_RISK_COUNT files)${NC} — route/DI/env/auth/sync surface, do not treat as plain safe-cherry-pick"
  echo -e "$HIGH_RISK_FILES"
  echo -e "  ${YELLOW}→ Upgrade to manual-port/manual-merge in the Intake Intent Issue${NC}"
  echo -e "  ${YELLOW}→ Fill Source Behavior + Must Preserve Home Behavior + Proof${NC}"
  echo ""
fi

if [ "$MANUAL_COUNT" -gt 0 ]; then
  echo -e "${YELLOW}⚠ manual-port ($MANUAL_COUNT files)${NC} — has outbound transforms, review diff manually"
  echo -e "$MANUAL_FILES"
fi

if [ "$PUBLIC_COUNT" -gt 0 ]; then
  echo -e "${BLUE}○ public-only ($PUBLIC_COUNT files)${NC} — skip (generated/replaced during sync)"
  echo -e "$PUBLIC_FILES"
fi

echo ""
echo -e "${BLUE}── Summary ──${NC}"
echo "  Total files: $((SAFE_COUNT + BRAND_COUNT + HIGH_RISK_COUNT + MANUAL_COUNT + PUBLIC_COUNT))"
echo -e "  ${GREEN}Safe:${NC}   $SAFE_COUNT  (auto-absorbable)"
if [ "$BRAND_COUNT" -gt 0 ]; then
  echo -e "  ${RED}Brand:${NC} $BRAND_COUNT  (🛡 manual diff-merge only!)"
fi
if [ "$HIGH_RISK_COUNT" -gt 0 ]; then
  echo -e "  ${RED}High-risk:${NC} $HIGH_RISK_COUNT  (manual-port + preserve proof)"
fi
echo -e "  ${YELLOW}Manual:${NC} $MANUAL_COUNT  (needs human review)"
echo -e "  ${BLUE}Skip:${NC}   $PUBLIC_COUNT  (public-only)"

if [ "$MODE" = "plan" ]; then
  echo ""
  echo -e "${BLUE}── Recommended Actions ──${NC}"
  if [ "$BRAND_COUNT" -gt 0 ]; then
    echo -e "  ${RED}0. 🛡 BRAND GUARD: Manually diff-merge $BRAND_COUNT brand-sensitive file(s)${NC}"
    echo "     Compare clowder-ai version with cat-cafe version, keep cat-cafe brand values"
    echo "     Run: bash scripts/intake-from-opensource.sh --validate-inbound"
  fi
  if [ "$HIGH_RISK_COUNT" -gt 0 ]; then
    echo -e "  ${RED}0. ⚠ HIGH-RISK GUARD: Treat $HIGH_RISK_COUNT high-risk file(s) as manual-port/manual-merge${NC}"
    echo "     Write Source Behavior + Must Preserve Home Behavior + Proof in the Intake Intent Issue"
  fi
  if [ "$SAFE_COUNT" -gt 0 ]; then
    echo "  1. Cherry-pick safe files from clowder-ai PR #$PR_NUMBER"
    echo "     (V2 will automate this with --mode=apply)"
  fi
  if [ "$MANUAL_COUNT" -gt 0 ]; then
    echo "  2. Manually review and port transformed files"
    echo "     Compare clowder-ai diff with cat-cafe source"
  fi
  echo "  3. Default lane: open the cat-cafe absorb PR with PR body lines:"
  echo "     Closes #<IntakeIntentIssue>   (one line per issue; auto-close on merge)"
  echo "  4. Record decision:"
  echo "     default lane:"
  echo "       --record --pr $PR_NUMBER --decision absorbed --intent-issue <I> --absorb-pr <P> --review-proof <URL|file>"
  echo "       (review-proof must explicitly cover current absorb PR HEAD SHA)"
  echo "     exception lane (direct-main historical backfill / outbound-filed hotfix):"
  echo "       --record --pr $PR_NUMBER --decision absorbed --skip-absorbed-guard"
  echo "       (issue / absorb PR / review-proof may be omitted; keep backfill note truthful)"
  echo "     (or: --decision public-only | --decision rejected)"
  echo "  5. After all PRs recorded: --advance-ledger"
  echo "  6. Default lane only: after absorb PR merge, confirm the Intake Intent Issue is closed"
elif [ "$MODE" = "apply" ]; then
  echo ""
  echo -e "${YELLOW}⚠ --mode=apply not yet implemented (V2)${NC}"
  echo "  For now, manually cherry-pick the safe files."
fi
