import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Installation-owned policy bytes, independent of the household dossier. */
export function createRoutingDossierFixture() {
  const root = mkdtempSync(join(tmpdir(), 'routing-dossier-'));
  mkdirSync(join(root, 'docs/team'), { recursive: true });
  writeFileSync(
    join(root, 'docs/team/cat-dossier.md'),
    `# Synthetic routing dossier

\`\`\`yaml
# structured-profile: cat:fable-5
entityId: "cat:fable-5"
engagementPolicy:
  quota: "weekly_subscription_scarce"
  defaultMode: "one_shot_calibration"
  highValueUses: ["architecture"]
  routineRepairReturn: "author_then_routine_reviewer_if_needed"
  reentry: "only_for_new_architecture_or_decision_judgment_or_explicit_cvo_request"
\`\`\`
`,
  );
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}
