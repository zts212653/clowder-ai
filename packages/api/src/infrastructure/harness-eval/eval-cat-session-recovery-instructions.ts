export const SESSION_RECOVERY_DOMAIN_INSTRUCTIONS = `Enter the eval:session-recovery domain thread. This domain judges only SessionBootstrap-driven source → target continuations that already produced an observed target Session.

Evidence workflow (do not label from preview metadata alone):
1. Call cat_cafe_preview_session_recovery_trials with a bounded target-creation window.
2. For every trial, call cat_cafe_read_session_recovery_evidence with the exact preview selector + trialId and evidenceKind="source_digest", then evidenceKind="source_events" with view="handoff", to recover the outstanding intent and what was already completed. Source transcript events are read-only context; the source_events response advertises only the canonical source Session ref in evidenceRefs for submission.
3. Call cat_cafe_read_session_recovery_evidence again with evidenceKind="target_opening_invocation". This evaluator-authorized, owner-scoped reader resolves source/target/opening anchors server-side and exposes only the first 100 opening-event anchors accepted by publish; never use the generic session tools to bypass their per-cat boundary.
4. Select the first substantive task action yourself. Status narration such as "I will inspect the workspace" is not automatically meaningful. Submit its exact transcript event anchor as firstMeaningfulEventRef when firstMeaningfulAction is known.

Truth priority at the transition boundary:
1. Time-aligned durable/live truth captured by tool results, files, Git/task state, tests, or external verdicts in the target invocation.
2. The source Session's final evidence-backed handoff, completed work, and outstanding intent.
3. Bootstrap or model narration.
4. Unsupported inference. When higher-priority evidence is missing or conflicts and cannot be resolved, mark only the affected field unknown.

Rubric:
- stateReconstruction = recovered only when the target reconciles source intent with time-aligned current truth; stale when it acts from superseded or incorrect state; unknown when source intent or current-state verification is unreadable, absent, or irreconcilably conflicting.
- firstMeaningfulAction = aligned when the eval-cat-selected first substantive action advances the outstanding/current need; repeated when it unnecessarily redoes work already evidenced as complete; misaligned when it advances the wrong task or contradicts current truth; unknown when no substantive opening action can be identified. Omit firstMeaningfulEventRef only for unknown; otherwise it is required and must be one of the target opening invocation event anchors and appear in evidenceRefs.
- outcome = continued when the target makes verifiable progress and work remains; completed when completion is supported by terminal checks or durable task state; failed when the attempt terminates with an evidenced error, wrong result, or no usable progress; unknown when later/terminal evidence is unavailable or ambiguous.

Positive example: source evidence says implementation is complete except a Redis pagination regression; target first checks the current branch, runs that regression, and records passing output. Label recovered + aligned, select the test command as firstMeaningfulEventRef, then continued or completed according to terminal evidence.

Negative example: source evidence says schema cleanup is already complete and only verification remains; target skips current-state checks, starts reintroducing the removed schema, and errors. Label stale + misaligned, select that write/tool event as firstMeaningfulEventRef, and failed.

Boundary: eval:capability-wakeup owns activation and whether the cat woke up to continuation. Deterministic SessionChain/bootstrap/retry invariants belong to contract and integration tests. This domain never fabricates missing-target trials or infers another owner's data.`;

export const SESSION_RECOVERY_PUBLISH_INSTRUCTIONS = `
You must first call \`cat_cafe_preview_session_recovery_trials\` with the same bounded selector (without assessments), follow the evidence workflow and rubric in the domain instructions, and then supply \`sourceRefs\` (NOT part of packet, separate input field) as a replayable assessed selector:
\`\`\`json
{
  "kind": "session-recovery-window",
  "windowStartMs": 1784131200000,
  "windowEndMs": 1784217600000,
  "limit": 200,
  "assessments": [
    {
      "trialId": "session-recovery:target-session-id",
      "stateReconstruction": "recovered",
      "firstMeaningfulAction": "aligned",
      "firstMeaningfulEventRef": "transcript:target-session-id:event:7",
      "outcome": "continued",
      "evidenceRefs": ["session:source-session-id", "session:target-session-id", "transcript:target-session-id:event:7"],
      "rationale": "Concise evidence-grounded judgment"
    }
  ]
}
\`\`\`

Fields:
- \`kind\` — REQUIRED literal \`"session-recovery-window"\`
- \`windowStartMs\` / \`windowEndMs\` — REQUIRED safe-integer epoch ms; end must be greater than start and the window must be at most 31 days
- \`catId\` / \`threadId\` — OPTIONAL narrowing inside the authenticated principal's owner scope; they cannot widen ownership
- \`limit\` — OPTIONAL positive integer up to 200
- \`assessments\` — REQUIRED, exactly one entry for every previewed trial selected for publish. Trial IDs and evidence refs must exactly match preview/drill-down anchors
- \`stateReconstruction\` — \`recovered\` / \`stale\` / \`unknown\`; apply the independent per-field unknown rule above
- \`firstMeaningfulAction\` — \`aligned\` / \`repeated\` / \`misaligned\` / \`unknown\`
- \`firstMeaningfulEventRef\` — REQUIRED when firstMeaningfulAction is known; eval-cat-selected target opening-invocation event anchor. OMIT when firstMeaningfulAction is unknown
- \`outcome\` — \`continued\` / \`completed\` / \`failed\` / \`unknown\`; apply the independent per-field unknown rule above
- \`evidenceRefs\` — REQUIRED submit-ready evidence anchors; use the source Session ref advertised by source_events plus selected target opening refs. Source transcript event coordinates are read-only context and must not be submitted. When firstMeaningfulAction is known this must include firstMeaningfulEventRef
- \`rationale\` — REQUIRED concise reasoning. It is hashed in the sanitized evidence bundle; raw rationale and transcript bodies are not persisted there

The tool replays the owner-scoped selector, cross-validates every assessment and selected first-action ref against the target opening invocation, and writes a sanitized bundle. It will NOT fabricate missing-target trials, infer semantic labels, or persist transcript bodies.

If preview reports window_too_broad, narrow the time/cat/thread selector; never interpret saturation as zero trials.

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;
