import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const publicFixture = new URL('../__fixtures__/valid-packs/quant-cats/', import.meta.url);

// Explicit demo inputs; never copy the installation's docs/packs data.
export async function createPackDemoFixture(root, { name, packType }) {
  await cp(publicFixture, root, { recursive: true });
  const manifest = parse(await readFile(join(root, 'pack.yaml'), 'utf8'));
  await writeFile(
    join(root, 'pack.yaml'),
    stringify({ ...manifest, name, packType, description: 'Independent pack pipeline fixture' }),
  );
  await writeFile(
    join(root, 'masks/analyst.yaml'),
    stringify({
      id: 'fixture-guide',
      name: 'Fixture Dungeon Master',
      roleOverlay: 'DM for an independent character story',
      personalityOverlay: 'Clear and consistent',
      expertise: ['fictional scenes'],
      activation: 'always',
    }),
  );
  await writeFile(
    join(root, 'guardrails.yaml'),
    stringify({
      constraints: [
        {
          id: 'fixture-character-boundary',
          scope: 'all-cats',
          rule: 'Keep character information within the scene',
          severity: 'block',
        },
      ],
    }),
  );
  return root;
}
