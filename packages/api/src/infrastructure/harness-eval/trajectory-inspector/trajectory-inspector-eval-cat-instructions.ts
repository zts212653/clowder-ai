export const TRAJECTORY_INSPECTOR_DOMAIN_INSTRUCTIONS =
  'Enter the eval:trajectory-inspector domain thread. Resolve a bounded owner-scoped trajectory-inspector-window through the F299 source adapter; do not submit caller-authored episodes. Every terminal error/cancelled/timeout and every F192 finding that explicitly targets an invocation is an eligible opportunity. Opening rate is not utility: keep not_taken and unresolved opportunities in the evidence-outcome denominator, and do not treat a successful detail-tool call or Raw/JSONL fallback as accepted root-cause evidence. Report the three-dimensional vector: time-to-first-accepted-evidence distribution, evidence outcome counts (accepted/unresolved/not_taken/wrong_ref), and Raw/JSONL fallback count. There is no composite score. Any wrong invocation or thread/session ref stops the utility conclusion and requires observation repair before re-eval. Fewer than 10 eligible episodes, degraded canonical coverage, significant model/runtime drift, reviewer disagreement above 20%, missing external review, or no comparable baseline permits only calibration/keep_observe; map tune/sunset to fix/delete_sunset only when every validity bound is usable.';

export const TRAJECTORY_INSPECTOR_PUBLISH_SELECTOR_INSTRUCTIONS = `
You must also supply \`sourceRefs\` as a bounded server-resolved selector:
\`\`\`json
{
  "kind": "trajectory-inspector-window",
  "windowStartMs": 1787533200000,
  "windowEndMs": 1788138000000
}
\`\`\`

The inclusive start and exclusive end are epoch milliseconds; end must be greater than start and the window must not exceed 31 days. The server derives every episode from the authenticated owner's canonical Session transcripts and explicit typed F192 bundle evidence. Do not submit episode rows, success labels, opening-rate metrics, or a threshold event. Keep \`not_taken\` and \`unresolved\` in the denominator. Any wrong invocation/thread/session ref, calibration-only validity, missing comparable baseline, or missing independent review permits only \`keep_observe\`. Use the canonical trajectory-inspector metric refs; the artifact stores the exact three-dimensional vector and no composite score.

The MCP tool creates the existing isolated evidence branch and PR. Do not write or push verdict artifacts directly.
`;
