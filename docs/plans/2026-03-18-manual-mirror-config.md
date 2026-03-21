# Manual Mirror Configuration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to explicitly configure mirror/download source overrides for install and startup scripts when default external sources are blocked, and document how to use those overrides.

**Architecture:** Add opt-in env/CLI override points at the script boundaries that currently hardcode upstream package/model/download sources. Bash startup should accept pass-through arguments from `pnpm start -- ...`; Windows install should read explicit override env vars instead of inventing automatic fallback behavior. Documentation must explain the override variables and example commands.

**Tech Stack:** Bash, PowerShell, Node.js built-in test runner, repo docs (`SETUP.md`, `.env.example`, optional `README.md`)

---

### Task 1: Define the override contract

**Files:**
- Modify: `scripts/start-dev.sh`
- Modify: `scripts/setup.sh`
- Modify: `scripts/whisper-server.sh`
- Modify: `scripts/qwen3-asr-server.sh`
- Modify: `scripts/llm-postprocess-server.sh`
- Modify: `scripts/install.ps1`
- Modify: `scripts/install-windows-helpers.ps1`
- Modify: `scripts/start-windows.ps1`
- Modify: `.env.example`

**Step 1: Decide exact variable names and scope**

Use a small, explicit contract only:
- `CAT_CAFE_NPM_REGISTRY`
- `CAT_CAFE_PIP_INDEX_URL`
- `CAT_CAFE_PIP_EXTRA_INDEX_URL`
- `CAT_CAFE_HF_ENDPOINT`
- `CAT_CAFE_MODEL_DOWNLOAD_BASE_URL` only if there is a real direct-download use case; skip if all model fetches already respect `HF_ENDPOINT`
- `CAT_CAFE_WINDOWS_REDIS_RELEASE_API`
- `CAT_CAFE_WINDOWS_REDIS_DOWNLOAD_URL`

Do **not** add automatic fallback lists in this task.

**Step 2: Decide CLI surface for Bash startup**

Support `pnpm start -- --npm-registry=... --pip-index-url=... --hf-endpoint=...` by parsing `start-dev.sh` args and exporting the matching env vars before sidecars/install helpers run.

**Step 3: Keep Windows surface env-only unless there is an existing argument parser seam**

Prefer `.env` / process env overrides on Windows to avoid widening multiple PowerShell entrypoints in one change.

### Task 2: Lock behavior with failing tests

**Files:**
- Modify: `packages/api/test/start-dev-script.test.js`
- Modify: `packages/api/test/windows-portable-redis-script.test.js`

**Step 1: Write the failing Bash test**

Add tests that assert:
- `start-dev.sh` source-only mode exposes a helper or parsed state for mirror overrides
- explicit mirror args export the expected env vars
- existing behavior is unchanged when no mirror args are provided

**Step 2: Run the Bash test to verify RED**

Run:
```bash
pnpm --filter @cat-cafe/api exec node --test test/start-dev-script.test.js
```

Expected: FAIL because the new override parsing/helpers do not exist yet.

**Step 3: Write the failing Windows regression test**

Add assertions that `install.ps1` / `install-windows-helpers.ps1`:
- reference explicit Redis release/download override env vars
- do not hardcode only the GitHub API/download path anymore

**Step 4: Run the Windows script test to verify RED**

Run:
```bash
pnpm --filter @cat-cafe/api exec node --test test/windows-portable-redis-script.test.js
```

Expected: FAIL because the override hooks are not implemented yet.

### Task 3: Implement Bash mirror override plumbing

**Files:**
- Modify: `scripts/start-dev.sh`
- Modify: `scripts/setup.sh`
- Modify: `scripts/whisper-server.sh`
- Modify: `scripts/qwen3-asr-server.sh`
- Modify: `scripts/llm-postprocess-server.sh`
- Modify: `.env.example`

**Step 1: Add argument parsing + env export in `start-dev.sh`**

Implement minimal parsing for:
- `--npm-registry=...`
- `--pip-index-url=...`
- `--pip-extra-index-url=...`
- `--hf-endpoint=...`

Map them to exported env vars once, near the existing top-level arg parsing.

**Step 2: Apply env vars where installs happen**

Update Bash scripts so that:
- `pnpm install` honors `NPM_CONFIG_REGISTRY`
- `pip install` honors `PIP_INDEX_URL` and `PIP_EXTRA_INDEX_URL`
- HuggingFace-backed model downloads honor `HF_ENDPOINT`

Use helper wrappers where possible to avoid duplicating export logic.

**Step 3: Keep sidecar model arguments independent**

Do not mix model-id overrides with mirror overrides; the existing first positional argument for model name should keep working.

**Step 4: Re-run Bash test to verify GREEN**

Run:
```bash
pnpm --filter @cat-cafe/api exec node --test test/start-dev-script.test.js
```

Expected: PASS.

### Task 4: Implement Windows explicit download override plumbing

**Files:**
- Modify: `scripts/install.ps1`
- Modify: `scripts/install-windows-helpers.ps1`
- Modify: `scripts/start-windows.ps1`
- Modify: `.env.example`

**Step 1: Add explicit Redis download override env vars**

In the helper that auto-downloads portable Redis, allow:
- override of the release metadata endpoint
- override of the final archive URL

Behavior:
- if explicit archive URL is set, download that directly
- else if explicit release API is set, query that
- else keep current GitHub default

**Step 2: Surface configuration in installer output**

Print which source is being used without leaking secrets.

**Step 3: Re-run Windows regression test to verify GREEN**

Run:
```bash
pnpm --filter @cat-cafe/api exec node --test test/windows-portable-redis-script.test.js
```

Expected: PASS.

### Task 5: Document manual configuration

**Files:**
- Modify: `SETUP.md`
- Modify: `.env.example`
- Modify: `README.md` if setup instructions there duplicate the startup/install flow

**Step 1: Add a “Network-constrained / mirror overrides” section**

Document:
- what problem this solves
- which variables/flags exist
- Bash example with `pnpm start -- ...`
- `.env` example for persistent config
- Windows example with PowerShell env vars before `install.ps1`

**Step 2: Make scope explicit**

State clearly:
- explicit overrides only
- no automatic China mirror fallback yet
- users should prefer internal/company mirrors when available

### Task 6: Final verification

**Files:**
- No code changes

**Step 1: Run targeted tests together**

Run:
```bash
pnpm --filter @cat-cafe/api exec node --test test/start-dev-script.test.js test/windows-portable-redis-script.test.js
```

Expected: PASS.

**Step 2: Sanity-check script docs**

Run:
```bash
rg -n "CAT_CAFE_NPM_REGISTRY|CAT_CAFE_PIP_INDEX_URL|CAT_CAFE_HF_ENDPOINT|CAT_CAFE_WINDOWS_REDIS" .env.example SETUP.md README.md scripts
```

Expected: each new override appears in docs and relevant scripts.

**Step 3: Commit**

```bash
git add packages/api/test/start-dev-script.test.js \
  packages/api/test/windows-portable-redis-script.test.js \
  scripts/start-dev.sh \
  scripts/setup.sh \
  scripts/whisper-server.sh \
  scripts/qwen3-asr-server.sh \
  scripts/llm-postprocess-server.sh \
  scripts/install.ps1 \
  scripts/install-windows-helpers.ps1 \
  scripts/start-windows.ps1 \
  .env.example \
  SETUP.md \
  README.md \
  docs/plans/2026-03-18-manual-mirror-config.md
git commit -m "feat: add manual mirror overrides for install scripts"
```
