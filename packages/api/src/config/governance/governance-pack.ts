/**
 * F070: Portable Governance Pack — content definitions
 *
 * Defines the managed block content that gets injected into
 * external project CLAUDE.md/AGENTS.md/GEMINI.md files.
 *
 * Port values use internal defaults (3001/6399/6398).
 * The sync-to-opensource pipeline transforms these to public
 * defaults (3004/6379/6380) via _sanitize-rules.pl and
 * sync-to-opensource.sh Step 3k-3b.
 */
import { createHash } from 'node:crypto';

export const GOVERNANCE_PACK_VERSION = '1.3.0';

export const MANAGED_BLOCK_START = '<!-- CAT-CAFE-GOVERNANCE-START -->';
export const MANAGED_BLOCK_END = '<!-- CAT-CAFE-GOVERNANCE-END -->';

const HARD_CONSTRAINTS = `## Cat Cafe Governance Rules (Auto-managed)

### Hard Constraints (immutable)
- **Public local defaults**: use frontend 3004 and API 3003 to avoid colliding with another local runtime.
- **Redis port 6379** is the default production Redis. Never connect to it from external projects. Use 6380 for dev/test.
- **No self-review**: The same individual cannot review their own code. Cross-family review preferred.
- **Identity is constant**: Never impersonate another cat. Identity is a hard constraint.

### Collaboration Standards
- A2A handoff uses five-tuple: What / Why / Tradeoff / Open Questions / Next Action
- Vision Guardian: Read original requirements before starting. AC completion ≠ feature complete.
- Review flow: quality-gate → request-review → receive-review → merge-gate
- Skills are available via symlinked cat-cafe-skills/ — load the relevant skill before each workflow step
- Shared rules: See cat-cafe-skills/refs/shared-rules.md for full collaboration contract

### Quality Discipline (overrides "try simplest approach first")
- **Bug: find root cause before fixing**. No guess-and-patch. Steps: reproduce → logs → call chain → confirm root cause → fix
- **Uncertain direction: stop → search → ask → confirm → then act**. Never "just try it first"
- **"Done" requires evidence** (tests pass / screenshot / logs). Bug fix = red test first, then green`;

const METHODOLOGY_INTRO = `### Knowledge Engineering
- Documents use YAML frontmatter (feature_ids, topics, doc_kind, created)
- Three-layer info architecture: CLAUDE.md (≤100 lines) → Skills (on-demand) → refs/
- Backlog: BACKLOG.md (hot) → Feature files (warm) → raw docs (cold)
- Feature lifecycle: kickoff → discussion → implementation → review → completion
- SOP: See docs/SOP.md for the 6-step workflow`;

export type Provider = 'claude' | 'codex' | 'gemini';

/**
 * Generate the managed block content for a specific provider.
 * This block is injected into the provider's instruction file
 * (CLAUDE.md, AGENTS.md, or GEMINI.md).
 */
export function getGovernanceManagedBlock(provider: Provider): string {
  return [
    MANAGED_BLOCK_START,
    `> Pack version: ${GOVERNANCE_PACK_VERSION} | Provider: ${provider}`,
    '',
    HARD_CONSTRAINTS,
    '',
    METHODOLOGY_INTRO,
    MANAGED_BLOCK_END,
  ].join('\n');
}

/**
 * Compute a stable checksum for the governance pack content.
 * Used for idempotency — skip re-sync if checksum matches.
 */
export function computePackChecksum(): string {
  const content = HARD_CONSTRAINTS + METHODOLOGY_INTRO + GOVERNANCE_PACK_VERSION;
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}
