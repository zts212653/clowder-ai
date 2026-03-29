import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Tests for manifest.yaml slashCommands discovery.
 * We test parseManifestSkillMeta indirectly through a helper that
 * exercises the same parsing logic with a temp manifest file.
 */

// Import the function that parses manifest metadata — we'll use a test helper
// that calls into the same code path via the capabilities module.
// Since parseManifestSkillMeta is not exported, we test via a thin wrapper.
import { parseManifestSlashCommands } from '../dist/infrastructure/commands/manifest-commands.js';

describe('parseManifestSlashCommands', () => {
  async function createTempManifest(yaml) {
    const dir = join(tmpdir(), `cat-cafe-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'manifest.yaml'), yaml, 'utf-8');
    return dir;
  }

  it('extracts valid slashCommands from manifest', async () => {
    const dir = await createTempManifest(`
skills:
  debugging:
    description: Debug a bug
    triggers: ["bug"]
    slashCommands:
      - name: /debug
        description: Debug a bug
      - name: /trace
        description: Trace execution
        surface: both
        subcommands: [start, stop]
`);
    const result = await parseManifestSlashCommands(dir);
    assert.ok(result.has('debugging'));
    const cmds = result.get('debugging');
    assert.equal(cmds.length, 2);
    assert.equal(cmds[0].name, '/debug');
    assert.equal(cmds[0].surface, 'connector'); // default
    assert.equal(cmds[1].name, '/trace');
    assert.equal(cmds[1].surface, 'both');
    assert.deepEqual(cmds[1].subcommands, ['start', 'stop']);
  });

  it('skips skill with no slashCommands field', async () => {
    const dir = await createTempManifest(`
skills:
  feat-lifecycle:
    description: Feature lifecycle
    triggers: ["new feature"]
`);
    const result = await parseManifestSlashCommands(dir);
    assert.ok(!result.has('feat-lifecycle'));
  });

  it('skips invalid commands and keeps valid ones', async () => {
    const dir = await createTempManifest(`
skills:
  mixed:
    description: Mixed
    slashCommands:
      - name: /good
        description: Valid command
      - name: BAD
        description: Missing slash
`);
    const result = await parseManifestSlashCommands(dir);
    assert.ok(result.has('mixed'));
    const cmds = result.get('mixed');
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].name, '/good');
  });

  it('returns empty map for missing manifest', async () => {
    const dir = join(tmpdir(), `cat-cafe-test-missing-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const result = await parseManifestSlashCommands(dir);
    assert.equal(result.size, 0);
  });

  it('rejects HTML in description', async () => {
    const dir = await createTempManifest(`
skills:
  xss:
    description: Bad skill
    slashCommands:
      - name: /xss
        description: "<script>alert(1)</script>"
`);
    const result = await parseManifestSlashCommands(dir);
    assert.ok(!result.has('xss'));
  });
});
