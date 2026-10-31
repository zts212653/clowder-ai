import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ownerTruthRefV1Schema } from '@cat-cafe/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { openEvolutionRoundInputSchema } from '../src/tools/capability-evolution-round-tools.js';
import { startEvolutionProgramInputSchema } from '../src/tools/capability-evolution-tools.js';

interface PatternEntry {
  path: string;
  pattern: string;
}

function patternsIn(value: unknown, path: string): PatternEntry[] {
  if (!value || typeof value !== 'object') return [];
  const entries: PatternEntry[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === 'pattern' && typeof child === 'string') entries.push({ path, pattern: child });
    else entries.push(...patternsIn(child, `${path}/${key}`));
  }
  return entries;
}

// JS permits a bare [ in a character class; Rust regex treats it as a nested
// class and rejects the old owner-ref pattern as unclosed. This is a bounded
// portability guard, not an emulation of Anthropic's complete validator.
function assertPortablePattern({ path, pattern }: PatternEntry): void {
  assert.doesNotThrow(() => new RegExp(pattern, 'u'), path);
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') index += 1;
    else if (char === '[') {
      assert.equal(inClass, false, `${path}: unescaped nested [ in ${pattern}`);
      inClass = true;
    } else if (char === ']') inClass = false;
  }
}

describe('MCP schema pattern portability', () => {
  it('detects the incident pattern even though JavaScript accepts it', () => {
    const pattern = '^[a-z][a-z0-9-]*:[^\\s{}[\\]"\']+$';
    assert.doesNotThrow(() => new RegExp(pattern, 'u'));
    assert.throws(() => assertPortablePattern({ path: 'incident/ownerStateRef', pattern }), /unescaped nested/);
  });

  it('checks every pattern delivered through the real tools/list registration', async () => {
    const server = createServer();
    const client = new Client({ name: 'schema-pattern-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      const patterns = listed.tools.flatMap((tool) => patternsIn(tool.inputSchema, tool.name));
      assert.ok(patterns.length > 0);
      assert.ok(patterns.some((entry) => entry.path.startsWith('cat_cafe_prepare_request_review_consumption/')));
      assert.ok(patterns.some((entry) => entry.path.endsWith('/joinKey')));
      for (const entry of patterns) assertPortablePattern(entry);

      const ownerPatterns = patterns.filter((entry) => entry.path.endsWith('/ownerStateRef'));
      assert.ok(ownerPatterns.length > 0);
      const examples: Array<[string, boolean]> = [
        ['skill:cat-cafe-skills/request-review/SKILL.md', true],
        ['message:thread_1:消息-2', true],
        ['source:a/b#c@v1', true],
        ['source:', false],
        ['no-kind', false],
        ...['[', ']', '{', '}', '"', "'", ' ', '\t', '\n'].map((char): [string, boolean] => [
          `source:a${char}b`,
          false,
        ]),
      ];
      for (const { path, pattern } of ownerPatterns) {
        for (const [value, expected] of examples) {
          assert.equal(new RegExp(pattern, 'u').test(value), expected, `${path}: ${JSON.stringify(value)}`);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('preserves owner-ref payload rejection and bounds in shared and duplicated MCP validators', () => {
    const validators = [
      ownerTruthRefV1Schema,
      startEvolutionProgramInputSchema.targetRef,
      openEvolutionRoundInputSchema.evidenceProofRef,
    ];
    for (const schema of validators) {
      for (const suffix of ['a/b#c@v1', 'thread_1:消息-2']) {
        assert.ok(schema.safeParse({ ownerFeatureId: 'F100', ownerStateRef: `source:${suffix}` }).success);
      }
      for (const suffix of ['[payload]', '{payload}', 'a b', 'a\nb', 'a"b', "a'b", 'x'.repeat(500)]) {
        assert.equal(schema.safeParse({ ownerFeatureId: 'F100', ownerStateRef: `source:${suffix}` }).success, false);
      }
    }
  });

  it('keeps the intentional escapes under the repository auto-fix command', () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const require = createRequire(import.meta.url);
    const biome = require.resolve('@biomejs/biome/bin/biome');
    for (const path of [
      'packages/shared/src/types/capability-evolution-refs.ts',
      'packages/shared/src/types/capability-evolution-observation.ts',
      'packages/mcp-server/src/tools/capability-evolution-tools.ts',
      'packages/mcp-server/src/tools/capability-evolution-round-tools.ts',
      'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/direct-repair/direct-repair-federation.ts',
      'packages/api/test/capability-evolution-evaluation-owner-join.test.js',
      'packages/api/test/harness-eval/measurement-decision-proof-normalized.test.js',
    ]) {
      const source = readFileSync(`${repoRoot}/${path}`, 'utf8');
      const fixed = execFileSync(process.execPath, [biome, 'check', '--write', `--stdin-file-path=${path}`], {
        cwd: repoRoot,
        input: source,
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(fixed, source, `${path}: auto-fix must preserve portable regex escapes`);
    }
  });
});
