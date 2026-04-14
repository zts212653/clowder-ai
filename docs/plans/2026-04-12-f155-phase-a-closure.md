# F155 Phase A Closure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the remaining Phase A follow-up items on the Phase B branch by verifying A-1 is already satisfied on rebased `main` and adding `schemaVersion` support with an implicit v1 migration path.

**Architecture:** A-1 is treated as a verification task because the rebased branch already contains the merged PR #398 cleanup. A-2 is implemented in the guide registry loader: flow YAML may declare `schemaVersion: 1`, but missing `schemaVersion` remains valid during the transition and is normalized to v1 at load time.

**Tech Stack:** Node.js, TypeScript, YAML, node:test

---

### Task 1: Verify A-1 closure on the rebased branch

**Files:**
- Inspect: `packages/`
- Inspect: `docs/features/F155-scene-guidance-engine.md`

**Step 1: Confirm no runtime `retreatStep` / `back` references remain**

Run: `rg -n "retreatStep|['\"]back['\"]" packages docs/features/F155-scene-guidance-engine.md`
Expected: only the checklist item in `docs/features/F155-scene-guidance-engine.md`

**Step 2: Record that A-1 is already satisfied**

No code change required if Step 1 matches expectation.

### Task 2: Add schemaVersion support to guide flow loading

**Files:**
- Modify: `guides/flows/add-member.yaml`
- Modify: `packages/api/src/domains/guides/guide-registry-loader.ts`
- Test: `packages/api/test/guide-registry-loader.test.js`

**Step 1: Write failing tests**

Add tests that:
- accept `schemaVersion: 1`
- treat missing `schemaVersion` as implicit v1
- reject unsupported versions

**Step 2: Run targeted tests to verify failure**

Run: `node --test packages/api/test/guide-registry-loader.test.js`
Expected: FAIL on missing loader/schema handling

**Step 3: Write minimal implementation**

Implement:
- `schemaVersion?: number` in raw flow type
- normalize missing version to `1`
- reject any version other than `1`

**Step 4: Update the shipped flow YAML**

Add `schemaVersion: 1` to `guides/flows/add-member.yaml`.

**Step 5: Run targeted tests to verify pass**

Run: `node --test packages/api/test/guide-registry-loader.test.js`
Expected: PASS

**Step 6: Sanity-check flow references**

Run: `node scripts/gen-guide-catalog.mjs`
Expected: generated catalog remains valid
