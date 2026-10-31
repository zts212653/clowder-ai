# Issue #315 Provider-Adaptive CLI Effort Implementation Plan

**Feature:** F127 residual — [docs/features/F127-cat-instance-management.md](../docs/features/F127-cat-instance-management.md)
**Goal:** Let a member retain any non-empty native CLI effort string while continuing to offer maintained client-specific presets and safe adapter-owned argument construction.
**Acceptance Criteria:**
- Hub exposes maintained effort presets and a direct text-entry path.
- Codex accepts native `max` and `ultra` through the structured effort field.
- Each existing effort-aware client adapter translates supported internal presets to its native CLI representation.
- A non-preset value is accepted, persisted, and passed through its selected-client adapter without enum-only rejection.
- Direct input reaches command construction through structured arguments, never unsafe shell concatenation.
- Provider-native validation failures remain visible to the operator.
- New invocations use saved values; existing sessions are not restarted.
- Tests cover preset conversion, passthrough, persistence, and provider-rejection reporting.
**Architecture cell:** `identity-session` (identity-agent subcell)
**Map delta:** none
**Map delta why:** This changes the existing cat-instance configuration contract and its adapters; it introduces no new owner or cross-cell boundary.
**Architecture:** Preserve a single `variant.cli.effort` string in the runtime catalog. The shared module continues to expose the maintained preset vocabulary for UI suggestions and default selection, while the route and loader accept any non-empty string. Claude and Codex retain adapter-owned argv construction; Codex serializes the TOML value rather than interpolating untrusted text.
**Tech Stack:** TypeScript, Zod, Fastify route tests, Vitest component tests, Node test runner.
**前端验证:** Yes — Hub Cat Editor coverage plus an isolated browser preview; formal approval requires interactive verification of the member-editor input and suggestions.

---

## Finish line and exclusions

The Hub member editor can select a maintained preset or enter `max`, `ultra`, or another native value. Saving preserves the exact string in `.cat-cafe/cat-catalog.json`, and the next Claude/Codex invocation receives it via its own argv adapter. We are **not** probing provider versions, maintaining provider-native enums, force-switching running sessions, or repurposing generic `cliConfigArgs`.

## Terminal contract

```ts
type CliEffortPreset = 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'ultra';
type CliEffortValue = string; // validated at API/schema boundary: trimmed and non-empty

interface CliConfig {
  effort?: CliEffortValue;
}
```

`getCliEffortOptionsForProvider(provider, model?)` is the maintained-preset source. It returns
model-aware suggestions when applicable (GPT-5.6 OpenAI models include `max` and `ultra`),
falling back to the base provider list otherwise. Runtime resolution returns a stored non-empty
value unchanged, otherwise the selected client's default; it must never coerce a native value
to a different preset. Effort is only accepted for effort-aware clients (anthropic, openai);
other clients receive HTTP 400 if `cli.effort` is supplied.

## Persistent-state census

| Object | Lifecycle owner | States/events | Invariants |
|---|---|---|---|
| `variant.cli.effort` in runtime catalog | `runtime-cat-catalog` via `/api/cats` | absent → saved preset/native string → edited/cleared | INV-1, INV-2 |
| Hub editor draft `cliEffort` | `HubCatEditor` form state | loaded → edited/selected → serialized | INV-2 |
| Invocation argv | provider adapter | config read → adapter serialization → spawned process | INV-3, INV-4 |

| State | Save preset | Save native `ultra` | Clear field | Client switch without explicit effort |
|---|---|---|---|---|
| Catalog | persist exact preset | persist exact native text | remove `effort` | replace with target-client default |
| New invocation | adapter emits native flag/value | same adapter emits exact native text | client default applies | target-client default applies |

**Invariants:**

- **INV-1:** The runtime catalog stores a user-entered non-empty effort value unchanged; it is not normalized to another provider's preset.
- **INV-2:** Form hydration and payload serialization round-trip both maintained presets and unfamiliar native values unchanged.
- **INV-3:** Only the selected provider adapter constructs CLI args; UI text never becomes a shell command string.
- **INV-4:** A new invocation reads the saved catalog value; pre-existing sessions are not mutated or restarted by this setting change.

**Adversarial scenarios:** blank/whitespace input is rejected or represented as clear; `max` and `ultra` on Codex preserve exactly; a quote-bearing value is TOML-escaped in Codex argv rather than interpreted as a second config; a provider rejects an otherwise accepted native value and its stderr/exit result remains observable.

## Test matrix

| Contract | Test location | Evidence |
|---|---|---|
| Preset suggestions remain client-specific | `hub-cat-editor.test.tsx`, shared effort tests | known preset lists unchanged |
| Native form hydration and payload | `hub-cat-editor.test.tsx` | `ultra` survives load and save |
| API create/patch persistence | `cats-routes-runtime-crud.test.js` | `max`/`ultra` persist without enum rejection |
| Loader passthrough/defaulting | `cat-config-loader.test.js` | native value retained; absent value defaults |
| Safe adapter construction | `codex-agent-service.test.js`, `claude-agent-service.test.js` | exact argv values and escaped TOML |
| Provider failure reporting | existing CLI error-path regression, extended if needed | exit/stderr stays operator-visible |

### Task 1: Make the configuration contract native-value tolerant

**Files:**
- Modify: `packages/shared/src/cli-effort.ts`
- Modify: `packages/shared/src/types/cat-breed.ts`
- Modify: `packages/api/src/config/cat-config-loader.ts`
- Test: `packages/api/test/cat-config-loader.test.js`

**Step 1: Write failing loader tests** for a stored Codex `max` and `ultra` effort, asserting exact retrieval and existing default behavior when absent.

**Step 2: Run the focused test** and confirm it fails because current normalization replaces/rejects the native value.

**Step 3: Implement the smallest contract change**: retain `CliEffortPreset` for maintained suggestions, accept a non-empty string for stored effort, and resolve stored text before applying a provider default.

**Step 4: Run focused shared/loader tests** and confirm all pass.

### Task 2: Accept and persist native values through the Cats API

**Files:**
- Modify: `packages/api/src/routes/cats.ts`
- Test: `packages/api/test/cats-routes-runtime-crud.test.js`

**Step 1: Write failing POST and PATCH tests** that save Codex `max` and `ultra`, then assert API response and catalog persistence retain the submitted strings.

**Step 2: Run those tests** and confirm Zod/provider-enum validation rejects them for the expected reason.

**Step 3: Replace enum-only validation with trimmed non-empty structured text validation.** Keep command/output/default args structured and reject blank values; do not concatenate input into a shell command.

**Step 4: Run focused route tests** and confirm preset/default client-switch regressions remain green.

### Task 3: Provide direct entry in the Hub editor

**Files:**
- Modify: `packages/web/src/components/hub-cat-editor.model.ts`
- Modify: `packages/web/src/components/hub-cat-editor-advanced.tsx`
- Test: `packages/web/src/components/__tests__/hub-cat-editor.test.tsx`

**Step 1: Write failing form/payload tests** showing a persisted `ultra` value is visible and a typed native value serializes in `cli.effort` independently of `cliConfigArgs`.

**Step 2: Run the focused component test** and confirm existing enum filtering clears the unfamiliar value.

**Step 3: Use an editable field with the selected client's preset list as suggestions.** Keep the control visible only for existing effort-aware adapters and retain the "use client default" clear behavior.

**Step 4: Run focused web tests** and confirm preset behavior still passes.

### Task 4: Keep adapter construction safe and observable

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/providers/CodexAgentService.ts`
- Test: `packages/api/test/codex-agent-service.test.js`
- Test: `packages/api/test/claude-agent-service.test.js`

**Step 1: Write a failing Codex argv regression test** for a quoted native value, asserting exactly one TOML `model_reasoning_effort` argument whose value is serialized safely; add `max`/`ultra` adapter assertions.

**Step 2: Run the targeted tests** and confirm unsafe interpolation or old normalization produces the wrong argv.

**Step 3: Serialize the Codex TOML string through the existing TOML string helper; leave Claude's separate `--effort`, value argv shape intact.** Do not add shell execution or provider-side validation in Cat Café.

**Step 4: Run focused provider tests** and validate the existing non-zero/stderr CLI error path still surfaces provider-native failures.

### Task 5: Verify and hand off

**Files:**
- Modify: all Task 1–4 files only

**Step 1:** Run formatting/type checks and all focused API/web/provider tests.

**Step 2:** Run the relevant package test suites and `pnpm check` with development-safe environment variables.

**Step 3:** Inspect the diff against every acceptance criterion and verify that no runtime configuration file or existing session was changed.

**Step 4:** Commit the plan and implementation in reviewable commits, request cross-individual review, and register the upstream PR for tracking after creation.
