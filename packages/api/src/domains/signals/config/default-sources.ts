import type { SignalSourceConfig } from '@cat-cafe/shared';
import { PAPER_SOURCES } from './sources-papers.js';
import { TIER1_CHINA_SOURCES } from './sources-tier1-china.js';
import { TIER1_GLOBAL_SOURCES } from './sources-tier1-global.js';
import { TIER2_COMMUNITY_SOURCES } from './sources-tier2-community.js';

/**
 * Default signal sources for Clowder AI Signal Hunter.
 *
 * Split into topic files under config/:
 *  - sources-tier1-global.ts  — Global AI labs (Anthropic → Groq)
 *  - sources-tier1-china.ts   — China AI labs + GitHub repos
 *  - sources-papers.ts        — arXiv + HuggingFace papers
 *  - sources-tier2-community.ts — OSS, bloggers, VC, aggregators
 *
 * Full provenance:
 *  - 缅因猫调研: docs/archive/2026-02/research/signal-hunter.md
 *  - 集成讨论: docs/archive/2026-02/discussions/2026-02-12-signal-hunter-upgrade/README.md
 *  - Gap 审计: docs/plans/2026-02-20-f21-signal-sources-gap.md
 */
export const DEFAULT_SIGNAL_SOURCES: SignalSourceConfig = {
  version: 1,
  sources: [...TIER1_GLOBAL_SOURCES, ...TIER1_CHINA_SOURCES, ...PAPER_SOURCES, ...TIER2_COMMUNITY_SOURCES],
};
