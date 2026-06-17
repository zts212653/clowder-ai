/**
 * F070: Portable Governance Pack — content definitions
 *
 * Defines the managed block content for Clowder AI itself and for
 * external project CLAUDE.md/AGENTS.md/GEMINI.md/KIMI.md files.
 *
 * Port values are read from environment variables at runtime,
 * falling back to home defaults (3003/3004/6399/6398).
 * Fixes #601 (Redis port hardcoding) and #602 (frontend/API port hardcoding).
 */
import { createHash } from 'node:crypto';

export const GOVERNANCE_PACK_VERSION = '1.4.1';

export const MANAGED_BLOCK_START = '<!-- CAT-CAFE-GOVERNANCE-START -->';
export const MANAGED_BLOCK_END = '<!-- CAT-CAFE-GOVERNANCE-END -->';

export type GovernanceManagedBlockContext = 'self' | 'external';

interface RuntimePorts {
  frontendPort: string;
  apiPort: string;
  redisPort: string;
  redisDevPort: string;
}

/** Read port config from env at call time so governance rules
 *  reflect the actual runtime ports, not hardcoded defaults.
 *
 *  NOTE: This makes the governance block (and its checksum) env-sensitive.
 *  Same git SHA with different env vars produces different checksums/content.
 *  External caches assuming "same cat-cafe version → same governance block"
 *  must account for this — use checksum as cache key, not version alone. */
function getRuntimePorts(): RuntimePorts {
  // Home defaults: frontend 3001 / API 3002 (sanitizer transforms `?? '3003'` → `?? '3003'`,
  // `?? '3004'` → `?? '3004'` on outbound sync). Redis ports stay as-is across both repos.
  return {
    frontendPort: process.env.FRONTEND_PORT ?? '3003',
    apiPort: process.env.API_SERVER_PORT ?? '3004',
    redisPort: process.env.REDIS_PORT ?? '6399',
    redisDevPort: process.env.REDIS_DEV_PORT ?? '6398',
  };
}

function getPortConstraint(context: GovernanceManagedBlockContext, ports: RuntimePorts): string {
  if (context === 'external') {
    return `- **Clowder AI runtime ports**: frontend ${ports.frontendPort} and API ${ports.apiPort} are reserved by Clowder AI. Avoid using these ports for this project's dev servers.`;
  }

  return `- **Public local defaults**: use frontend ${ports.frontendPort} and API ${ports.apiPort} to avoid colliding with another local runtime.`;
}

function getHardConstraints(context: GovernanceManagedBlockContext = 'self'): string {
  const ports = getRuntimePorts();

  return `## Clowder AI Governance Rules (Auto-managed)

### Hard Constraints (immutable)
${getPortConstraint(context, ports)}
- **Redis port ${ports.redisPort}** is Clowder AI's production Redis. Never connect to it from external projects. Use ${ports.redisDevPort} for dev/test.
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
}

const METHODOLOGY_INTRO = `### Knowledge Engineering
- Documents use YAML frontmatter (feature_ids, topics, doc_kind, created)
- Three-layer info architecture: CLAUDE.md (≤100 lines) → Skills (on-demand) → refs/
- Backlog: BACKLOG.md (hot) → Feature files (warm) → raw docs (cold)
- Feature lifecycle: kickoff → discussion → implementation → review → completion
- SOP: See docs/SOP.md for the 6-step workflow`;

export type Provider = 'claude' | 'codex' | 'gemini' | 'kimi';

/**
 * Generate the managed block content for a specific provider.
 * This block is injected into the provider's instruction file
 * (CLAUDE.md, AGENTS.md, GEMINI.md, or KIMI.md).
 */
export function getGovernanceManagedBlock(provider: Provider, context: GovernanceManagedBlockContext = 'self'): string {
  return [
    MANAGED_BLOCK_START,
    `> Pack version: ${GOVERNANCE_PACK_VERSION} | Provider: ${provider}`,
    '',
    getHardConstraints(context),
    '',
    METHODOLOGY_INTRO,
    MANAGED_BLOCK_END,
  ].join('\n');
}

/**
 * Compute a stable checksum for the governance pack content.
 * Used for idempotency — skip re-sync if checksum matches.
 * Includes env-derived port values so checksum changes when ports change.
 */
export function computePackChecksum(context: GovernanceManagedBlockContext = 'self'): string {
  const content = getHardConstraints(context) + METHODOLOGY_INTRO + GOVERNANCE_PACK_VERSION;
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}
