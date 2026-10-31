import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Synthetic source text exercises the real scanner's 300-character summary
// boundary. It is neither a copy of the home lesson nor evidence about history.
export function writeOperationalPrecedentFixture(docsRoot) {
  mkdirSync(docsRoot, { recursive: true });
  writeFileSync(
    join(docsRoot, 'lessons-learned.md'),
    `# Synthetic lessons

### LL-098: zero-step billing/spending-limit synthetic operational precedent

runner_id=0; steps=[]; billing/spending-limit; fixture-policy-no-account-action. ${'Synthetic evidence remains separate from code execution. '.repeat(20)}
`,
  );
  mkdirSync(join(docsRoot, 'taste/vignettes'), { recursive: true });
  writeFileSync(
    join(docsRoot, 'taste/vignettes/legacy-source.md'),
    `---
when: 2026-01-01
quotes: ["Inspect the supplied evidence."]
scene: Synthetic legacy source; 给了原始数据 is a fixture marker.
tags: [synthetic-legacy]
---
`,
  );
}
