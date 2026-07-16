export const SESSION_RECOVERY_DOMAIN_INSTRUCTIONS =
  "Enter the eval:session-recovery domain thread. First call `cat_cafe_preview_session_recovery_trials` with a bounded window, then inspect the returned metadata and evidence anchors before assigning semantic assessments. Judge post-transition recovery correctness: whether the target session reconstructed current state, whether its first meaningful action aligned with the outstanding intent instead of unnecessarily repeating completed work, and whether the task continued or completed. Keep the boundary explicit: eval:capability-wakeup measures activation (whether the capability woke); eval:session-recovery measures correctness after the session transition. Preview and publish are owner-scoped to the authenticated principal; never request or infer another owner's sessions. Structural lineage/delivery failures are deterministic evidence and cannot be erased by a semantic pass.";

export const SESSION_RECOVERY_PUBLISH_INSTRUCTIONS = `
You must first call \`cat_cafe_preview_session_recovery_trials\` with the same bounded selector (without assessments), inspect the returned evidence anchors, and then supply \`sourceRefs\` (NOT part of packet, separate input field) as a replayable assessed selector:
\`\`\`json
{
  "kind": "session-recovery-window",
  "windowStartMs": 1784131200000,
  "windowEndMs": 1784217600000,
  "limit": 200,
  "assessments": [
    {
      "trialId": "session-recovery:source-session-id",
      "stateReconstruction": "recovered",
      "firstMeaningfulAction": "aligned",
      "outcome": "continued",
      "evidenceRefs": ["session:source-session-id", "transcript:target-session-id:event:1"],
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
- \`assessments\` — REQUIRED, exactly one entry for every previewed trial selected for publish. Trial IDs and evidence refs must exactly match preview anchors
- \`stateReconstruction\` — contextAlignment judgment: \`recovered\` / \`stale\` / \`unknown\`
- \`firstMeaningfulAction\` — intentRepetition judgment: \`aligned\` / \`repeated\` / \`misaligned\` / \`unknown\`
- \`outcome\` — \`continued\` / \`completed\` / \`failed\` / \`unknown\`
- \`rationale\` — REQUIRED concise reasoning. It is hashed in the sanitized evidence bundle; raw rationale and transcript bodies are not persisted there

The tool replays the owner-scoped selector, cross-validates every assessment against the previewable trial/evidence anchors, and writes a sanitized bundle. Structural failures remain failures regardless of semantic assessment. The tool will NOT fabricate trials, infer semantic labels, or persist transcript bodies.

The MCP tool creates branch \`verdict/auto/{domainSlug}/{verdictId}\` + commits + opens PR. Returns commit SHA + PR URL.

**DO NOT** run \`git add\`, \`git commit\`, \`git push\`, or write verdict files directly. Use the MCP tool.
`;
