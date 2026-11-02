import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function writeF209RecallFixtures(root) {
  const files = [
    [
      'A',
      'f209-phase-a-raw-retrieval-fixtures.md',
      [
        {
          Query: '`fixture semantic`',
          Scope: '`threads`',
          Mode: '`semantic`',
          Depth: '`raw`',
          'Expected anchor pattern': 'a source shaped `thread-*`',
          'Negative guard': 'do not substitute a summary',
        },
        {
          Query: '`fixture hybrid`',
          Scope: '`threads`',
          Mode: '`hybrid`',
          Depth: '`raw`',
          'Expected anchor pattern': '`thread-*`',
        },
      ],
    ],
    [
      'B',
      'f209-phase-b-entity-anchor-fixtures.md',
      [
        {
          Query: '`fixture owner`',
          Mode: '`lexical`',
          Scope: '`docs`',
          Depth: '`summary`',
          'Expected anchor pattern': '`document-coordinate`',
        },
        { Query: '`fixture person`', Mode: '`lexical`', 'Expected anchor pattern': '`thread-*`' },
        { Query: '`fixture collection`', 'Expected drilldown': '`collection-coordinate`' },
      ],
    ],
    [
      'C',
      'f209-phase-c-drilldown-fixtures.md',
      [
        {
          'Search query': '`fixture semantic`',
          'Search scope': '`threads`',
          'Search mode/depth': '`semantic` / `raw`',
          'Search result': '`document-coordinate`',
        },
        { 'Search result': '`kind=session`, anchor shape `session-*`' },
        { 'Expected drilldown': '`message-coordinate`' },
      ],
    ],
  ];
  for (const [phase, name, fixtures] of files) {
    const path = join(root, 'docs/eval', name);
    mkdirSync(dirname(path), { recursive: true });
    const sections = fixtures
      .map(
        (fields, index) =>
          `## Fixture ${index + 1}: Independent ${phase} case ${index + 1}\n\n| Field | Value |\n|---|---|\n${Object.entries(
            fields,
          )
            .map(([key, value]) => `| ${key} | ${value} |`)
            .join('\n')}`,
      )
      .join('\n\n');
    writeFileSync(
      path,
      `---\ndoc_kind: eval-fixture\nfeature_ids: [F209, F200]\nphase: ${phase}\n---\n\n${sections}\n`,
    );
  }
}
