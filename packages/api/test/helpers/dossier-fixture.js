import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDossierSnapshot } from '@cat-cafe/shared/dossier';

export function writeDossierFixture(root) {
  const directory = join(root, 'docs/team');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'cat-dossier.md'),
    `# Independent dossier fixture

\`\`\`yaml
# structured-profile: cat:fable-5
entityId: "cat:fable-5"
identity:
  pronouns: "戊/fixture-pronoun"
  l0PronounReminder: true
l0RosterSummary: "fixture-roster-canary"
l0RoutingNote: "fixture-route-canary"
l0SelfDescription: "fixture-self-canary"
\`\`\`
`,
  );
  const snapshot = loadDossierSnapshot(root);
  assert.equal(snapshot.state, 'loaded');
  assert.deepEqual(snapshot.diagnostics, []);
  assert.equal(snapshot.profiles.get('fable-5')?.l0RoutingNote, 'fixture-route-canary');
}
