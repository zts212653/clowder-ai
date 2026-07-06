// @ts-check

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * F252 Phase D — Content sanitizer tests (AC-D2).
 *
 * The sanitizer walks transcript event content and applies
 * content-class redaction rules. Unlike the OTel TelemetryRedactor
 * (which operates on span attributes), this operates on event text.
 *
 * INV-6: No raw paths, tokens, env vars, or internal names survive.
 */

describe('sanitizeEventContent', () => {
  /** @returns {Promise<typeof import('../dist/domains/story/content-sanitizer.js')>} */
  async function loadModule() {
    return import('../dist/domains/story/content-sanitizer.js');
  }

  // ─── Class A: Credentials ──────────────────────────────────────

  test('redacts API keys (sk-ant-api03-*)', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e1',
      at: 1000,
      kind: 'tool_use',
      content: 'Calling API with key sk-ant-api03-abc123xyz-very-long-key',
    });
    assert.ok(!result.content.includes('sk-ant-api03'), 'API key should be redacted');
    assert.ok(result.content.includes('[REDACTED]'));
  });

  test('redacts GitHub tokens (ghp_*, gho_*, ghs_*)', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e2',
      at: 1000,
      kind: 'text',
      content: 'Token: ghp_abc123def456ghi789jkl0 and gho_xyz987wvu654',
    });
    assert.ok(!result.content.includes('ghp_'), 'GitHub PAT should be redacted');
    assert.ok(!result.content.includes('gho_'), 'GitHub OAuth should be redacted');
  });

  test('redacts callback tokens', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e3',
      at: 1000,
      kind: 'text',
      content: 'X-Callback-Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def',
    });
    assert.ok(!result.content.includes('eyJ'), 'JWT-like token should be redacted');
  });

  test('redacts Anthropic API keys', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e4',
      at: 1000,
      kind: 'text',
      content: 'ANTHROPIC_API_KEY=sk-ant-api03-longlonglonglonglongkey',
    });
    assert.ok(!result.content.includes('sk-ant-api03'));
  });

  // ─── Class B: File paths ───────────────────────────────────────

  test('redacts absolute file paths (/home/user', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e5',
      at: 1000,
      kind: 'tool_use',
      content: 'Read file /home/user/cat-cafe/packages/api/src/index.ts',
    });
    assert.ok(!result.content.includes('/home/user'), 'Absolute path should be redacted');
    assert.ok(result.content.includes('[PATH]'));
  });

  test('redacts worktree paths', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e6',
      at: 1000,
      kind: 'text',
      content: 'cd /home/user/cat-cafe-f252-phase-d',
    });
    assert.ok(!result.content.includes('/Users/'));
    assert.ok(result.content.includes('[PATH]'));
  });

  test('redacts /tmp paths', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e7',
      at: 1000,
      kind: 'text',
      content: 'Writing to /tmp/cat-cafe-review/f252/opus/test.json',
    });
    assert.ok(!result.content.includes('/tmp/'));
    assert.ok(result.content.includes('[PATH]'));
  });

  // ─── Class C: Environment variables ────────────────────────────

  test('redacts REDIS_URL assignments', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e8',
      at: 1000,
      kind: 'text',
      content: 'REDIS_URL=redis://localhost:6399',
    });
    assert.ok(!result.content.includes('redis://localhost'), 'Redis URL should be redacted');
    assert.ok(result.content.includes('[CONFIG]'));
  });

  test('redacts .env.local content blocks', async () => {
    const { sanitizeEventContent } = await loadModule();
    const envContent = `cat > .env.local <<EOF
REDIS_URL=redis://localhost:6398
ANTHROPIC_API_KEY=sk-ant-api03-secretkey
NEXT_PUBLIC_API_URL=http://localhost:3102
EOF`;
    const result = sanitizeEventContent({
      id: 'e9',
      at: 1000,
      kind: 'tool_use',
      content: envContent,
    });
    assert.ok(!result.content.includes('sk-ant-api03'));
    assert.ok(!result.content.includes('redis://localhost'));
  });

  test('redacts generic KEY=value patterns for sensitive keys', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e10',
      at: 1000,
      kind: 'text',
      content: 'DATABASE_URL=postgres://user:pass@host:5432/db SECRET_KEY=mysecretvalue123',
    });
    assert.ok(!result.content.includes('postgres://'));
    assert.ok(!result.content.includes('mysecretvalue123'));
  });

  // ─── Passthrough: safe content ─────────────────────────────────

  test('preserves normal discussion text', async () => {
    const { sanitizeEventContent } = await loadModule();
    const content = 'The annotation feature uses narration and highlight markers at arbitrary timestamps.';
    const result = sanitizeEventContent({
      id: 'e11',
      at: 1000,
      kind: 'text',
      content,
    });
    assert.equal(result.content, content);
  });

  test('preserves code snippets without secrets', async () => {
    const { sanitizeEventContent } = await loadModule();
    const content = 'const x = 42;\nfunction foo() { return bar; }';
    const result = sanitizeEventContent({
      id: 'e12',
      at: 1000,
      kind: 'text',
      content,
    });
    assert.equal(result.content, content);
  });

  // ─── Tool args/result sanitization ─────────────────────────────

  test('redacts toolArgs containing file paths', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e13',
      at: 1000,
      kind: 'tool_use',
      content: 'Reading file',
      toolName: 'Read',
      toolArgs: '{"file_path": "/home/user/cat-cafe/src/index.ts"}',
    });
    assert.ok(result.toolArgs);
    assert.ok(!result.toolArgs.includes('/home/user'));
  });

  test('redacts toolResult containing secrets', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e14',
      at: 1000,
      kind: 'tool_result',
      content: 'Tool completed',
      toolResult: 'API_KEY=sk-ant-api03-secretvalue REDIS_URL=redis://localhost:6399',
    });
    assert.ok(result.toolResult);
    assert.ok(!result.toolResult.includes('sk-ant-api03'));
    assert.ok(!result.toolResult.includes('redis://localhost'));
  });

  // ─── Output shape ──────────────────────────────────────────────

  test('output preserves id, at, kind, catId when no map provided', async () => {
    const { sanitizeEventContent } = await loadModule();
    const result = sanitizeEventContent({
      id: 'e15',
      at: 1719360000000,
      kind: 'text',
      content: 'hello',
      catId: 'opus',
    });
    assert.equal(result.id, 'e15');
    assert.equal(result.at, 1719360000000);
    assert.equal(result.kind, 'text');
    // Without catNameMap, catId passes through (standalone use, not for export)
    assert.equal(result.catId, 'opus');
  });

  // ─── Class D: catId anonymization ─────────────────────────────

  test('catId is anonymized when catNameMap is provided', async () => {
    const { sanitizeEventContent } = await loadModule();
    const catNameMap = new Map([['opus', 'Participant 1']]);
    const result = sanitizeEventContent(
      { id: 'e16', at: 1000, kind: 'text', content: 'hello', catId: 'opus' },
      catNameMap,
    );
    assert.equal(result.catId, 'Participant 1');
  });

  test('unknown catId gets fallback label when map provided', async () => {
    const { sanitizeEventContent } = await loadModule();
    const catNameMap = new Map([['opus', 'Participant 1']]);
    const result = sanitizeEventContent(
      { id: 'e17', at: 1000, kind: 'text', content: 'hello', catId: 'unknown-cat' },
      catNameMap,
    );
    assert.equal(result.catId, '[Participant]');
  });
});

describe('sanitizeStoryExport', () => {
  test('sanitizes all events in the export pack', async () => {
    const { sanitizeStoryExport } = await import('../dist/domains/story/content-sanitizer.js');

    const events = [
      {
        id: 'e1',
        at: 1000,
        kind: 'text',
        content: 'Check /home/user/cat-cafe/src/file.ts',
      },
      {
        id: 'e2',
        at: 2000,
        kind: 'tool_use',
        content: 'Using key sk-ant-api03-secretkey123',
        toolArgs: '{"key": "ghp_tokenvalue123456789012345"}',
      },
    ];

    const annotations = [
      {
        id: 'a1',
        storyId: 'feat:F252',
        at: 1500,
        kind: /** @type {const} */ ('narration'),
        content: 'Important moment',
        createdAt: 1000,
        updatedAt: 1000,
      },
    ];

    const pack = sanitizeStoryExport('feat:F252', 'F252 Story', events, annotations);

    assert.equal(pack.manifest.storyId, 'feat:F252');
    assert.equal(pack.manifest.title, 'F252 Story');
    assert.equal(pack.manifest.eventCount, 2);
    assert.equal(pack.events.length, 2);

    // Verify INV-6: no sensitive content survives
    for (const event of pack.events) {
      assert.ok(!event.content.includes('/home/user'), `Event ${event.id} content leaked path`);
      assert.ok(!event.content.includes('sk-ant-api03'), `Event ${event.id} content leaked API key`);
      if (event.toolArgs) {
        assert.ok(!event.toolArgs.includes('ghp_'), `Event ${event.id} toolArgs leaked token`);
      }
    }

    // Annotations content should be sanitized too (P1-2 fix)
    for (const a of pack.manifest.annotations) {
      assert.ok(!a.content.includes('sk-ant-api03'), `Annotation leaked API key`);
    }
  });

  // ─── P1-2: Annotation content must be sanitized ────────────────

  test('annotations in export pack have content sanitized', async () => {
    const { sanitizeStoryExport } = await import('../dist/domains/story/content-sanitizer.js');
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'clean event' }];
    const annotations = [
      {
        id: 'a1',
        storyId: 's1',
        at: 1000,
        kind: /** @type {const} */ ('narration'),
        content: 'My key is sk-ant-api03-secretAnnotation123',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'a2',
        storyId: 's1',
        at: 2000,
        kind: /** @type {const} */ ('highlight'),
        content: 'Path /home/user/secret/dir matters',
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'a3',
        storyId: 's1',
        at: 3000,
        kind: /** @type {const} */ ('narration'),
        content: 'DB at redis://admin:pass@host:6379',
        createdAt: 3,
        updatedAt: 3,
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, annotations);

    // Class A: credential in annotation content → [REDACTED]
    assert.ok(!pack.manifest.annotations[0].content.includes('sk-ant-api03'), 'annotation leaked API key');
    assert.ok(pack.manifest.annotations[0].content.includes('[REDACTED]'), 'annotation should have [REDACTED]');

    // Class B: path in annotation content → [PATH]
    assert.ok(!pack.manifest.annotations[1].content.includes('/home/user'), 'annotation leaked path');
    assert.ok(pack.manifest.annotations[1].content.includes('[PATH]'), 'annotation should have [PATH]');

    // Class C: redis URL in annotation content → [CONFIG]
    assert.ok(!pack.manifest.annotations[2].content.includes('redis://'), 'annotation leaked config');
    assert.ok(pack.manifest.annotations[2].content.includes('[CONFIG]'), 'annotation should have [CONFIG]');
  });

  // ─── Audit finding: title must be sanitized ────────────────────

  // ─── Class D: catId anonymization in export ────────────────────

  test('export anonymizes internal catIds to Participant N labels', async () => {
    const { sanitizeStoryExport } = await import('../dist/domains/story/content-sanitizer.js');
    const events = [
      { id: 'e1', at: 1000, kind: 'text', content: 'first message', catId: 'opus' },
      { id: 'e2', at: 2000, kind: 'text', content: 'reply', catId: 'codex' },
      { id: 'e3', at: 3000, kind: 'text', content: 'follow-up', catId: 'opus' },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, []);

    // No internal catId should survive
    for (const e of pack.events) {
      assert.ok(e.catId !== 'opus', `Event ${e.id} leaked internal catId 'opus'`);
      assert.ok(e.catId !== 'codex', `Event ${e.id} leaked internal catId 'codex'`);
    }

    // Same internal catId → same anonymous label (deterministic)
    assert.equal(pack.events[0].catId, pack.events[2].catId, 'Same cat should map to same label');
    // Different catIds → different labels
    assert.notEqual(pack.events[0].catId, pack.events[1].catId, 'Different cats should get different labels');
    // First appearance order
    assert.equal(pack.events[0].catId, 'Participant 1');
    assert.equal(pack.events[1].catId, 'Participant 2');
  });

  test('export redacts catId handles in free-text content', async () => {
    const { sanitizeStoryExport } = await import('../dist/domains/story/content-sanitizer.js');
    const events = [
      { id: 'e1', at: 1000, kind: 'text', content: '@opus reviewed the PR', catId: 'opus' },
      { id: 'e2', at: 2000, kind: 'text', content: 'codex found a bug, opus agreed', catId: 'codex' },
      {
        id: 'e3',
        at: 3000,
        kind: 'tool_use',
        content: 'Run test',
        catId: 'opus',
        toolArgs: 'args from opus session',
        toolResult: 'codex approved the change',
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, []);

    // @mention form in content should be anonymized
    assert.ok(!pack.events[0].content.includes('@opus'), 'Content leaked @opus mention');
    assert.ok(pack.events[0].content.includes('@Participant'), '@mention should use Participant label');

    // Standalone catId words in content should be anonymized
    assert.ok(!pack.events[1].content.includes('codex'), 'Content leaked codex reference');
    assert.ok(!pack.events[1].content.includes('opus'), 'Content leaked opus reference');
    assert.ok(pack.events[1].content.includes('Participant'), 'Content should have Participant labels');

    // toolArgs and toolResult should also be redacted
    assert.ok(!pack.events[2].toolArgs?.includes('opus'), 'toolArgs leaked cat handle');
    assert.ok(!pack.events[2].toolResult?.includes('codex'), 'toolResult leaked cat handle');
  });

  test('export redacts catId handles in annotation content', async () => {
    const { sanitizeStoryExport } = await import('../dist/domains/story/content-sanitizer.js');
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'msg', catId: 'opus' }];
    const annotations = [
      {
        id: 'a1',
        storyId: 's1',
        at: 1000,
        kind: /** @type {const} */ ('narration'),
        content: 'opus made a key decision here',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, annotations);

    // Annotation content should have cat handle redacted
    assert.ok(!pack.manifest.annotations[0].content.includes('opus'), 'Annotation leaked cat handle');
    assert.ok(pack.manifest.annotations[0].content.includes('Participant'), 'Annotation should use Participant label');
  });

  test('standalone sanitizeEventContent without map does NOT redact cat names in content', async () => {
    const { sanitizeEventContent } = await import('../dist/domains/story/content-sanitizer.js');
    // No catNameMap → standalone use (non-export) → catId handles pass through in content
    const result = sanitizeEventContent({
      id: 'e1',
      at: 1000,
      kind: 'text',
      content: '@opus reviewed the code',
      catId: 'opus',
    });
    assert.ok(result.content.includes('@opus'), 'Without map, content cat handles should pass through');
    assert.equal(result.catId, 'opus', 'Without map, catId field passes through');
  });

  test('export pack includes class-d-identity in sanitization rules', async () => {
    const { sanitizeStoryExport } = await import('../dist/domains/story/content-sanitizer.js');
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'clean' }];
    const pack = sanitizeStoryExport('s1', 'Test', events, []);
    assert.ok(pack.manifest.sanitizationRules.includes('class-d-identity'), 'Should declare Class D rule');
  });

  // ─── Audit finding: title must be sanitized ────────────────────

  test('export pack title is sanitized', async () => {
    const { sanitizeStoryExport } = await import('../dist/domains/story/content-sanitizer.js');
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'clean' }];
    const pack = sanitizeStoryExport('s1', 'Session with sk-ant-api03-titleSecret789', events, []);

    assert.ok(!pack.manifest.title.includes('sk-ant-api03'), 'title leaked API key');
    assert.ok(pack.manifest.title.includes('[REDACTED]'), 'title should have [REDACTED]');
  });

  // ─── R6: Hyphenated catId collision prevention ──────────────
  // opus-47 must NOT be corrupted to Participant 1-47 when both
  // opus and opus-47 are in the roster

  test('hyphenated catId is not corrupted by shorter prefix catId', async () => {
    const { sanitizeStoryExport } = await import('../dist/domains/story/content-sanitizer.js');
    const events = [
      { id: 'e1', at: 1000, kind: 'text', content: '@opus-47 reviewed the PR', catId: 'opus-47' },
      { id: 'e2', at: 2000, kind: 'text', content: '@opus wrote the code', catId: 'opus' },
      { id: 'e3', at: 3000, kind: 'text', content: 'opus-47 and opus discussed', catId: 'opus' },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, []);

    // opus-47 = Participant 1, opus = Participant 2 (first appearance order)
    assert.equal(pack.events[0].catId, 'Participant 1');
    assert.equal(pack.events[1].catId, 'Participant 2');

    // @opus-47 in content must become @Participant 1 (NOT @Participant 2-47)
    assert.ok(
      pack.events[0].content.includes('@Participant 1'),
      `Expected @Participant 1 but got: ${pack.events[0].content}`,
    );
    assert.ok(!pack.events[0].content.includes('Participant 2'), 'opus-47 was corrupted by opus prefix match');

    // Standalone 'opus-47' in content must become Participant 1
    assert.ok(
      pack.events[2].content.includes('Participant 1'),
      `Expected Participant 1 for opus-47 in: ${pack.events[2].content}`,
    );
    // Standalone 'opus' must become Participant 2
    assert.ok(
      pack.events[2].content.includes('Participant 2'),
      `Expected Participant 2 for opus in: ${pack.events[2].content}`,
    );
  });

  // ─── R6: Display names / nicknames / mention aliases ────────
  // cat-config.json breeds have displayName (布偶猫), nickname (宪宪),
  // mentionPatterns (@ragdoll, @布偶, etc.) — all must be redacted

  test('export redacts displayName, nickname, and mention aliases', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');

    // Simulate breeds from cat-config.json
    const breeds = [
      {
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        nickname: '宪宪',
        mentionPatterns: ['@opus', '@布偶猫', '@布偶', '@ragdoll', '@宪宪'],
        variants: [{ catId: 'opus-47', displayName: '布偶猫 Opus 4.7', mentionPatterns: ['@opus47', '@opus-47'] }],
      },
      {
        catId: 'codex',
        name: '缅因猫',
        displayName: '缅因猫',
        nickname: '砚砚',
        mentionPatterns: ['@codex', '@缅因猫', '@缅因', '@maine', '@砚砚'],
        variants: [],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    const events = [
      {
        id: 'e1',
        at: 1000,
        kind: 'text',
        content: '布偶猫说："宪宪觉得没问题"',
        catId: 'opus',
      },
      {
        id: 'e2',
        at: 2000,
        kind: 'text',
        content: '@ragdoll reviewed, 砚砚 approved. 缅因猫 also looked.',
        catId: 'codex',
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // No identity alias should survive in content
    assert.ok(!pack.events[0].content.includes('布偶猫'), 'Leaked displayName 布偶猫');
    assert.ok(!pack.events[0].content.includes('宪宪'), 'Leaked nickname 宪宪');
    assert.ok(!pack.events[1].content.includes('ragdoll'), 'Leaked mention alias ragdoll');
    assert.ok(!pack.events[1].content.includes('砚砚'), 'Leaked nickname 砚砚');
    assert.ok(!pack.events[1].content.includes('缅因猫'), 'Leaked displayName 缅因猫');

    // All should be replaced with Participant labels
    assert.ok(pack.events[0].content.includes('Participant 1'), 'Missing Participant 1 for opus aliases');
    assert.ok(pack.events[1].content.includes('Participant 2'), 'Missing Participant 2 for codex aliases');
  });

  test('buildCatIdentityAliases handles variant aliases independently', async () => {
    const { buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      {
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        nickname: '宪宪',
        mentionPatterns: ['@opus', '@布偶猫', '@宪宪'],
        variants: [
          { catId: 'opus-47', displayName: '布偶猫 Opus 4.7', mentionPatterns: ['@opus47', '@opus-47'] },
          { catId: 'sonnet', displayName: '布偶猫 Sonnet', mentionPatterns: ['@sonnet'] },
        ],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // Breed-level aliases
    const opusAliases = aliases.get('opus');
    assert.ok(opusAliases, 'opus should have aliases');
    assert.ok(opusAliases.includes('布偶猫'), 'opus aliases should include displayName');
    assert.ok(opusAliases.includes('宪宪'), 'opus aliases should include nickname');

    // Variant-level aliases (separate catId → separate aliases)
    const opus47Aliases = aliases.get('opus-47');
    assert.ok(opus47Aliases, 'opus-47 should have aliases');
    assert.ok(opus47Aliases.includes('布偶猫 Opus 4.7'), 'opus-47 aliases should include variant displayName');
    assert.ok(opus47Aliases.includes('opus47'), 'opus-47 aliases should include mention without @');
    // opus-47 should NOT be an alias (it's the catId itself)
    assert.ok(!opus47Aliases.includes('opus-47'), 'opus-47 should not be in its own alias list');

    const sonnetAliases = aliases.get('sonnet');
    assert.ok(sonnetAliases, 'sonnet should have aliases');
    assert.ok(sonnetAliases.includes('布偶猫 Sonnet'), 'sonnet aliases should include variant displayName');
  });

  test('buildCatIdentityAliases includes variant.name and variant.nickname (clowder-ai#1090)', async () => {
    // clowder-ai#1090 introduced variant-scoped name / nickname persistence
    // for multi-variant breed members. Story export redaction must pick these
    // up — otherwise a renamed member's identity leaks into public exports.
    const { buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      {
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        nickname: '宪宪',
        mentionPatterns: ['@opus', '@布偶猫', '@宪宪'],
        variants: [
          {
            catId: 'sonnet',
            // Simulate clowder-ai#1090: multi-variant member rename
            name: '斯奈特秘名',
            nickname: '斯奈特昵称',
            displayName: '布偶猫 Sonnet',
            variantLabel: 'Sonnet',
            mentionPatterns: ['@sonnet'],
          },
          {
            catId: 'opus-47',
            displayName: '布偶猫 Opus 4.7',
            variantLabel: 'Opus 4.7',
            mentionPatterns: ['@opus-47'],
          },
        ],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    const sonnetAliases = aliases.get('sonnet');
    assert.ok(sonnetAliases, 'sonnet should have aliases');
    assert.ok(
      sonnetAliases.includes('斯奈特秘名'),
      `sonnet aliases must include variant.name (redaction gap): ${JSON.stringify(sonnetAliases)}`,
    );
    assert.ok(
      sonnetAliases.includes('斯奈特昵称'),
      `sonnet aliases must include variant.nickname (redaction gap): ${JSON.stringify(sonnetAliases)}`,
    );
    // Existing variant aliases still populated
    assert.ok(sonnetAliases.includes('布偶猫 Sonnet'), 'sonnet aliases should still include displayName');
    assert.ok(sonnetAliases.includes('Sonnet'), 'sonnet aliases should still include variantLabel');
  });

  test('buildCatIdentityAliases merges default-variant identity overrides into breed entry (clowder-ai#1090)', async () => {
    // Multi-variant breed default variants typically have no explicit
    // variant.catId (they inherit breed.catId, e.g. `opus-default`).
    // updateRuntimeCat now writes name / nickname onto that variant when the
    // breed has multiple variants — so those overrides must still be
    // discoverable by the sanitizer even though the variant has no v.catId.
    // Since default variants share the breed's catId at runtime, their
    // identity overrides get merged into the breed alias entry.
    const { buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      {
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶显示名',
        nickname: '宪宪',
        mentionPatterns: ['@opus'],
        variants: [
          {
            // Default variant: no catId (inherits breed.catId = 'opus')
            // Persisted identity overrides written by updateRuntimeCat:
            name: '默认新名字',
            nickname: '默认新昵称',
          },
          {
            catId: 'opus-sonnet',
            displayName: '布偶猫 Sonnet',
            mentionPatterns: ['@opus-sonnet'],
          },
        ],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    const opusAliases = aliases.get('opus');
    assert.ok(opusAliases, 'opus breed catId must have aliases');
    assert.ok(opusAliases.includes('布偶猫'), 'opus aliases retain breed.name');
    assert.ok(opusAliases.includes('布偶显示名'), 'opus aliases retain breed.displayName');
    assert.ok(opusAliases.includes('宪宪'), 'opus aliases retain breed.nickname');
    assert.ok(
      opusAliases.includes('默认新名字'),
      `opus aliases must include default variant name override: ${JSON.stringify(opusAliases)}`,
    );
    assert.ok(
      opusAliases.includes('默认新昵称'),
      `opus aliases must include default variant nickname override: ${JSON.stringify(opusAliases)}`,
    );

    // Non-default variant still gets independent alias entry
    const sonnetAliases = aliases.get('opus-sonnet');
    assert.ok(sonnetAliases, 'opus-sonnet aliases still populated');
    assert.ok(sonnetAliases.includes('布偶猫 Sonnet'), 'opus-sonnet displayName preserved');
  });

  test('buildCatIdentityAliases skips variant.name that collides with breed identity (clowder-ai#1090)', async () => {
    // Breed-level identity is shared: variant.name equal to breed.name/displayName
    // must NOT be attached to a variant catId, else first-wins collision maps
    // the breed's canonical name to a single variant.
    const { buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      {
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶显示名',
        mentionPatterns: ['@opus'],
        variants: [
          // variant.name collides with breed.name — should not be added to variant aliases
          { catId: 'sonnet', name: '布偶猫', displayName: '布偶显示名', mentionPatterns: ['@sonnet'] },
        ],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    const sonnetAliases = aliases.get('sonnet');
    // sonnet aliases may be empty or only contain non-colliding items, but
    // must NOT rebind the shared breed name to the variant.
    assert.ok(
      !sonnetAliases || !sonnetAliases.includes('布偶猫'),
      `variant.name collision with breed.name must not be added to variant aliases: ${JSON.stringify(sonnetAliases)}`,
    );
    // Existing displayName collision guard unchanged
    assert.ok(
      !sonnetAliases || !sonnetAliases.includes('布偶显示名'),
      'variant.displayName collision with breed.displayName must not be added',
    );
  });

  test('non-participating roster catIds mentioned in content are also redacted', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      {
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        nickname: '宪宪',
        mentionPatterns: ['@opus', '@布偶猫'],
        variants: [],
      },
      {
        catId: 'gemini',
        name: '暹罗猫',
        displayName: '暹罗猫',
        nickname: '烁烁',
        mentionPatterns: ['@gemini', '@暹罗猫', '@烁烁'],
        variants: [],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // Only opus is an event author — gemini is just mentioned in content
    const events = [
      {
        id: 'e1',
        at: 1000,
        kind: 'text',
        content: '让 @gemini 来看看设计，烁烁比较有审美',
        catId: 'opus',
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // gemini aliases should still be redacted (non-participating but mentioned)
    assert.ok(!pack.events[0].content.includes('gemini'), 'Leaked non-participating catId gemini');
    assert.ok(!pack.events[0].content.includes('烁烁'), 'Leaked non-participating nickname 烁烁');
  });

  // ─── R7: variantLabel redaction ─────────────────────────────
  // variantLabel values like "Sonnet", "Opus 4.7", "GPT-5.4" must be redacted

  test('export redacts variantLabel identities', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      {
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        mentionPatterns: ['@opus'],
        variants: [
          { catId: 'sonnet', displayName: '布偶猫 Sonnet', variantLabel: 'Sonnet', mentionPatterns: ['@sonnet'] },
          { catId: 'opus-47', displayName: '布偶猫 Opus 4.7', variantLabel: 'Opus 4.7', mentionPatterns: ['@opus-47'] },
        ],
      },
      {
        catId: 'codex',
        name: '缅因猫',
        displayName: '缅因猫',
        mentionPatterns: ['@codex'],
        variants: [
          { catId: 'gpt52', displayName: '缅因猫 GPT-5.4', variantLabel: 'GPT-5.4', mentionPatterns: ['@gpt52'] },
        ],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    const events = [
      {
        id: 'e1',
        at: 1000,
        kind: 'text',
        content: 'Sonnet did the alpha test, Opus 4.7 did vision guardian, GPT-5.4 reviewed',
        catId: 'opus',
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // "Sonnet" is ambiguous (pure alpha, 6 chars ≤ 7) — without @mention,
    // Phase 2 detection skips it, so standalone "Sonnet" in prose survives.
    // This prevents corrupting sentences like "A sonnet about cats".
    assert.ok(
      pack.events[0].content.includes('Sonnet'),
      `Sonnet should survive (ambiguous common word): ${pack.events[0].content}`,
    );
    // "Opus 4.7" and "GPT-5.4" are distinctive (contain space+digit / hyphen+digit)
    // — standalone detection and redaction work normally.
    assert.ok(!pack.events[0].content.includes('Opus 4.7'), 'Leaked variantLabel Opus 4.7');
    assert.ok(!pack.events[0].content.includes('GPT-5.4'), 'Leaked variantLabel GPT-5.4');
    assert.ok(pack.events[0].content.includes('Participant'), 'Should have Participant labels');
  });

  // ─── R7: Case-insensitive standalone matching ─────────────
  // Codex/OPUS/Ragdoll at sentence start must match lowercase catIds

  test('standalone identifier match is case-insensitive', async () => {
    const { sanitizeStoryExport } = await import('../dist/domains/story/content-sanitizer.js');
    const events = [
      { id: 'e1', at: 1000, kind: 'text', content: 'Opus reviewed it', catId: 'opus' },
      { id: 'e2', at: 2000, kind: 'text', content: 'CODEX found a bug', catId: 'codex' },
      { id: 'e3', at: 3000, kind: 'text', content: 'Then Opus and Codex agreed', catId: 'opus' },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, []);

    // Capitalized forms should be redacted
    assert.ok(!pack.events[0].content.includes('Opus'), 'Leaked capitalized Opus');
    assert.ok(!pack.events[1].content.includes('CODEX'), 'Leaked uppercase CODEX');
    assert.ok(!pack.events[2].content.includes('Opus'), 'Leaked Opus in mixed case');
    assert.ok(!pack.events[2].content.includes('Codex'), 'Leaked Codex in mixed case');
    assert.ok(pack.events[0].content.includes('Participant 1'), 'Missing label for Opus');
    assert.ok(pack.events[1].content.includes('Participant 2'), 'Missing label for CODEX');
  });

  // ─── R7: coCreator identity redaction ─────────────────────
  // Co-creator name/aliases (You, L.S., Lysander) must be redacted

  test('coCreator identity is redacted in export', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [{ catId: 'opus', name: '布偶猫', displayName: '布偶猫', mentionPatterns: ['@opus'], variants: [] }];
    const coCreator = { name: 'You', aliases: ['L.S.', 'Lysander'], mentionPatterns: ['@co-creator', '@co-creator'] };
    const aliases = buildCatIdentityAliases(breeds, coCreator);

    const events = [
      {
        id: 'e1',
        at: 1000,
        kind: 'text',
        content: '@co-creator co-creator说 You 觉得没问题，Lysander approved',
        catId: 'opus',
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // "You" is NOT a common English word — it's a distinctive proper name.
    // Even though short (5 chars), it's not in AMBIGUOUS_COMMON_WORDS, so
    // Phase 2 uses full standalone detection and redaction.
    assert.ok(!pack.events[0].content.includes('You'), 'Leaked coCreator name');
    assert.ok(!pack.events[0].content.includes('Lysander'), 'Leaked coCreator alias');
    assert.ok(!pack.events[0].content.includes('you'), 'Leaked coCreator mention');
  });

  // ─── R8: shared breed name belongs to breed catId, not variant ──
  // When variants share breed displayName (e.g. sonnet displayName='布偶猫'),
  // the breed name must map to the breed catId's Participant label.

  test('shared breed displayName belongs to breed catId not first-appearing variant', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    // Real config pattern: sonnet variant has displayName='布偶猫' (same as breed)
    const breeds = [
      {
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        nickname: '宪宪',
        mentionPatterns: ['@opus'],
        variants: [{ catId: 'sonnet', displayName: '布偶猫', variantLabel: 'Sonnet', mentionPatterns: ['@sonnet'] }],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // '布偶猫' should NOT be in sonnet's alias set (breed owns it)
    const sonnetAliases = aliases.get('sonnet');
    assert.ok(sonnetAliases, 'sonnet should have aliases');
    assert.ok(!sonnetAliases.includes('布偶猫'), '布偶猫 should NOT be in sonnet aliases — breed owns it');
    assert.ok(sonnetAliases.includes('Sonnet'), 'sonnet should still have variantLabel');

    // In export: sonnet appears first, then opus — '布偶猫' must map to opus's label
    const events = [
      { id: 'e1', at: 1000, kind: 'text', content: '布偶猫 approved the design', catId: 'sonnet' },
      { id: 'e2', at: 2000, kind: 'text', content: 'done', catId: 'opus' },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // sonnet = Participant 1, opus = Participant 2
    assert.strictEqual(pack.events[0].catId, 'Participant 1');
    assert.strictEqual(pack.events[1].catId, 'Participant 2');
    // '布偶猫' in text must resolve to opus (Participant 2), NOT sonnet (Participant 1)
    assert.ok(
      pack.events[0].content.includes('Participant 2'),
      `布偶猫 should map to opus (P2), got: ${pack.events[0].content}`,
    );
  });

  // ─── R8: dense participant numbering (no roster size leak) ──────
  // Phase 2 should only number identities actually mentioned in text

  test('participant numbers are dense — unreferenced roster entries get no label', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      { catId: 'opus', name: '布偶猫', displayName: '布偶猫', mentionPatterns: ['@opus'], variants: [] },
      { catId: 'codex', name: '缅因猫', displayName: '缅因猫', mentionPatterns: ['@codex'], variants: [] },
      {
        catId: 'gemini',
        name: '暹罗猫',
        displayName: '暹罗猫',
        nickname: '烁烁',
        mentionPatterns: ['@gemini'],
        variants: [],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // Only opus is event author, only gemini is mentioned in text — codex is never referenced
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'asked @gemini for design review', catId: 'opus' }];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // opus = Participant 1 (author), gemini = Participant 2 (mentioned)
    // codex should NOT be numbered — never referenced
    assert.strictEqual(pack.events[0].catId, 'Participant 1');
    // gemini mentioned in text gets Participant 2, not Participant 3
    assert.ok(
      pack.events[0].content.includes('Participant 2'),
      `gemini should be P2 (dense), got: ${pack.events[0].content}`,
    );
    assert.ok(!pack.events[0].content.includes('Participant 3'), 'No Participant 3 — codex was never referenced');
  });

  // ─── R9: identity in title/annotations also triggers Phase 2 ──
  // Phase 2 pre-scan must cover all sanitized text surfaces

  test('identity only in title is detected and redacted', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      { catId: 'opus', name: '布偶猫', displayName: '布偶猫', mentionPatterns: ['@opus'], variants: [] },
      {
        catId: 'gemini',
        name: '暹罗猫',
        displayName: '暹罗猫',
        nickname: '烁烁',
        mentionPatterns: ['@gemini'],
        variants: [],
      },
    ];
    const coCreator = { name: 'You', aliases: ['Lysander'], mentionPatterns: ['@co-creator'] };
    const aliases = buildCatIdentityAliases(breeds, coCreator);

    // Only opus is event author — Lysander only appears in the title
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'hello', catId: 'opus' }];
    const pack = sanitizeStoryExport('s1', 'Lysander review session', events, [], aliases);

    assert.ok(!pack.manifest.title.includes('Lysander'), `Title leaked Lysander: ${pack.manifest.title}`);
    assert.ok(pack.manifest.title.includes('Participant'), 'Title should have Participant label');
  });

  test('identity only in annotation is detected and redacted', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      { catId: 'opus', name: '布偶猫', displayName: '布偶猫', mentionPatterns: ['@opus'], variants: [] },
      {
        catId: 'gemini',
        name: '暹罗猫',
        displayName: '暹罗猫',
        nickname: '烁烁',
        mentionPatterns: ['@gemini'],
        variants: [],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // Only opus is event author — gemini only appears in an annotation
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'hello world', catId: 'opus' }];
    const annotations = [
      {
        id: 'a1',
        storyId: 's1',
        at: 2000,
        kind: 'narration',
        content: '@gemini 的审美很好',
        createdAt: 2000,
        updatedAt: 2000,
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, annotations, aliases);

    const annoContent = pack.manifest.annotations[0].content;
    assert.ok(!annoContent.includes('gemini'), `Annotation leaked gemini: ${annoContent}`);
    assert.ok(!annoContent.includes('烁烁'), `Annotation leaked 烁烁: ${annoContent}`); // Not in annotation but alias of gemini — 暹罗猫 is
    assert.ok(annoContent.includes('Participant'), `Annotation should have Participant label: ${annoContent}`);
  });

  // ─── R10: boundary-aware Phase 2 detection ─────────────────────
  // Phase 2 detection must use boundary-aware regex, not includes()
  // "declare" contains "dare" as substring but "dare" is not standalone

  test('Phase 2 does not falsely detect catId embedded in longer word', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      { catId: 'opus', name: '布偶猫', displayName: '布偶猫', mentionPatterns: ['@opus'], variants: [] },
      { catId: 'dare', name: '狸花猫', displayName: '狸花猫', mentionPatterns: ['@dare'], variants: [] },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // Only opus is event author. "declare" and "software" contain "dare" as substring
    // but dare is NOT standalone — Phase 2 should NOT allocate a label for dare
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'we declare this software ready', catId: 'opus' }];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // "declare" and "software" must NOT be corrupted
    assert.ok(pack.events[0].content.includes('declare'), `"declare" was corrupted: ${pack.events[0].content}`);
    assert.ok(pack.events[0].content.includes('software'), `"software" was corrupted: ${pack.events[0].content}`);
    // dare should NOT appear as a Participant (never standalone-referenced)
    assert.ok(
      !pack.events[0].content.includes('Participant 2'),
      'dare should not get a Participant label from embedded substring',
    );
  });

  test('standalone common-word catId in prose is NOT redacted (Phase 2 ambiguous)', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      { catId: 'opus', name: '布偶猫', displayName: '布偶猫', mentionPatterns: ['@opus'], variants: [] },
      {
        catId: 'spark',
        name: '缅因猫 Spark',
        displayName: '缅因猫 Spark',
        mentionPatterns: ['@spark'],
        variants: [{ catId: 'spark', displayName: '缅因猫 Spark', variantLabel: 'Spark', mentionPatterns: ['@spark'] }],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // "spark reviewed" uses spark as standalone word — but spark is a Phase 2
    // non-author with a pure ASCII catId. Standalone common words in prose
    // should NOT be redacted to avoid corrupting English text.
    // Only @mention form triggers detection and redaction for ambiguous identifiers.
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'A spark of inspiration', catId: 'opus' }];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // Standalone "spark" in prose must survive — no over-redaction
    assert.ok(
      pack.events[0].content.includes('spark'),
      `Standalone spark was over-redacted: ${pack.events[0].content}`,
    );
    // spark should NOT get a Participant label (no @mention signal in text)
    assert.ok(
      !pack.events[0].content.includes('Participant 2'),
      `spark should not get a Participant label from standalone prose: ${pack.events[0].content}`,
    );
  });

  test('@mention of common-word catId IS redacted even when standalone is not', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      { catId: 'opus', name: '布偶猫', displayName: '布偶猫', mentionPatterns: ['@opus'], variants: [] },
      {
        catId: 'spark',
        name: '缅因猫 Spark',
        displayName: '缅因猫 Spark',
        mentionPatterns: ['@spark'],
        variants: [{ catId: 'spark', displayName: '缅因猫 Spark', variantLabel: 'Spark', mentionPatterns: ['@spark'] }],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // @spark is an explicit identity signal — redact @mention form.
    // But standalone "spark" in prose should still survive.
    const events = [
      { id: 'e1', at: 1000, kind: 'text', content: '@spark reviewed. A spark of inspiration.', catId: 'opus' },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // @spark → @Participant 2 (redacted via @mention)
    assert.ok(!pack.events[0].content.includes('@spark'), `@spark leaked: ${pack.events[0].content}`);
    assert.ok(
      pack.events[0].content.includes('@Participant'),
      `@mention should be redacted: ${pack.events[0].content}`,
    );
    // Standalone "spark" in "A spark of inspiration" survives
    assert.ok(
      pack.events[0].content.includes('spark of inspiration'),
      `Prose was corrupted: ${pack.events[0].content}`,
    );
  });

  test('Phase 1 author with common-word catId still gets full standalone redaction', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      {
        catId: 'spark',
        name: '缅因猫 Spark',
        displayName: '缅因猫 Spark',
        mentionPatterns: ['@spark'],
        variants: [],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // spark IS the event author (Phase 1) — full redaction including standalone.
    // Phase 1 authors always get both @mention and standalone redaction because
    // the reader can cross-reference with the catId field in event metadata.
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'spark reviewed the code', catId: 'spark' }];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // Phase 1 author → full redaction, standalone "spark" is replaced
    assert.ok(!pack.events[0].content.includes('spark'), `Phase 1 author spark leaked: ${pack.events[0].content}`);
    assert.ok(pack.events[0].content.includes('Participant 1'), `Should be Participant 1: ${pack.events[0].content}`);
  });

  test('unambiguous CJK alias of common-word Phase 2 catId still gets standalone redaction', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      { catId: 'opus', name: '布偶猫', displayName: '布偶猫', mentionPatterns: ['@opus'], variants: [] },
      {
        catId: 'spark',
        name: '缅因猫 Spark',
        displayName: '缅因猫 Spark',
        mentionPatterns: ['@spark'],
        variants: [],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // spark is Phase 2 non-author. Its CJK alias "缅因猫 Spark" is unambiguous
    // (contains CJK) — standalone CJK should still be detected and redacted.
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: '缅因猫 Spark 的意见很好', catId: 'opus' }];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    // CJK alias is unambiguous — standalone detection and redaction both work
    assert.ok(!pack.events[0].content.includes('缅因猫 Spark'), `CJK alias leaked: ${pack.events[0].content}`);
    assert.ok(
      pack.events[0].content.includes('Participant'),
      `Should have Participant label: ${pack.events[0].content}`,
    );
  });

  // ─── R12: Per-identifier ambiguity at alias level ─────────────
  // Common-word aliases (not just catIds) must be mention-only in Phase 2.
  // Covers reviewer R11 examples: "A sonnet about cats", "a golden opportunity".

  test('common-word variantLabel "Sonnet" does not corrupt prose (per-identifier ambiguity)', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      { catId: 'opus', name: '布偶猫', displayName: '布偶猫', mentionPatterns: ['@opus'], variants: [] },
      {
        catId: 'codex',
        name: '缅因猫',
        displayName: '缅因猫',
        mentionPatterns: ['@codex'],
        variants: [
          { catId: 'sonnet', displayName: '布偶猫 Sonnet', variantLabel: 'Sonnet', mentionPatterns: ['@sonnet'] },
        ],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // "sonnet" is a Phase 2 non-author catId. Both "sonnet" and "Sonnet" are
    // ambiguous (pure alpha, ≤ 7 chars) — they must not corrupt English prose.
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'A sonnet about cats', catId: 'opus' }];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    assert.ok(
      pack.events[0].content.includes('sonnet'),
      `Prose "A sonnet about cats" was corrupted: ${pack.events[0].content}`,
    );
    assert.ok(
      !pack.events[0].content.includes('Participant'),
      `Should have no Participant label (no @mention signal): ${pack.events[0].content}`,
    );
  });

  test('@sonnet IS redacted even though standalone "sonnet" in prose survives', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const breeds = [
      { catId: 'opus', name: '布偶猫', displayName: '布偶猫', mentionPatterns: ['@opus'], variants: [] },
      {
        catId: 'codex',
        name: '缅因猫',
        displayName: '缅因猫',
        mentionPatterns: ['@codex'],
        variants: [
          { catId: 'sonnet', displayName: '布偶猫 Sonnet', variantLabel: 'Sonnet', mentionPatterns: ['@sonnet'] },
        ],
      },
    ];
    const aliases = buildCatIdentityAliases(breeds);

    // @sonnet is an explicit identity signal — redact. But standalone "sonnet"
    // in prose must survive.
    const events = [
      { id: 'e1', at: 1000, kind: 'text', content: '@sonnet reviewed. A sonnet about cats.', catId: 'opus' },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    assert.ok(!pack.events[0].content.includes('@sonnet'), `@sonnet leaked: ${pack.events[0].content}`);
    assert.ok(
      pack.events[0].content.includes('@Participant'),
      `@mention should be redacted: ${pack.events[0].content}`,
    );
    assert.ok(pack.events[0].content.includes('sonnet about cats'), `Prose was corrupted: ${pack.events[0].content}`);
  });

  // ── Cloud R1 P1 fixes ──

  test('sk-proj- OpenAI project-scoped keys are redacted (cloud P1-2)', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const aliases = buildCatIdentityAliases([]);

    const projKey = 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234';
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: `Key is ${projKey}`, catId: 'opus' }];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    assert.ok(!pack.events[0].content.includes('sk-proj-'), `sk-proj- key leaked in export: ${pack.events[0].content}`);
    assert.ok(pack.events[0].content.includes('[REDACTED]'), `Should contain [REDACTED]: ${pack.events[0].content}`);
  });

  test('/workspace/ paths are redacted (cloud P1-1)', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const aliases = buildCatIdentityAliases([]);

    const events = [
      {
        id: 'e1',
        at: 1000,
        kind: 'text',
        content: 'File at /workspace/cat-cafe/packages/api/src/index.ts',
        catId: 'opus',
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    assert.ok(
      !pack.events[0].content.includes('/workspace/cat-cafe'),
      `/workspace/ path leaked: ${pack.events[0].content}`,
    );
    assert.ok(pack.events[0].content.includes('[PATH]'), `Should contain [PATH]: ${pack.events[0].content}`);
  });

  // ── Cloud R2 P1/P2 fixes ──

  test('ghu_ and ghr_ GitHub tokens are redacted (cloud R2 P1-5)', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const aliases = buildCatIdentityAliases([]);

    const events = [
      {
        id: 'e1',
        at: 1000,
        kind: 'text',
        content: 'user token ghu_abc123def456 and refresh ghr_xyz789abcdef',
        catId: 'opus',
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);

    assert.ok(!pack.events[0].content.includes('ghu_'), `ghu_ token leaked: ${pack.events[0].content}`);
    assert.ok(!pack.events[0].content.includes('ghr_'), `ghr_ token leaked: ${pack.events[0].content}`);
  });

  test('/root/, /etc/, /opt/, /app/ container paths are redacted (cloud R4 P1-2)', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const aliases = buildCatIdentityAliases([]);
    const events = [
      {
        id: 'e1',
        at: 1000,
        kind: 'tool_result',
        content:
          'Config at /root/.config/cat-cafe/settings.json and /etc/nginx/nginx.conf and /opt/homebrew/bin/node and /app/packages/api/src/index.ts',
        catId: 'opus',
      },
    ];
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);
    assert.ok(!pack.events[0].content.includes('/root/.config'), `/root/ path leaked: ${pack.events[0].content}`);
    assert.ok(!pack.events[0].content.includes('/etc/nginx'), `/etc/ path leaked: ${pack.events[0].content}`);
    assert.ok(!pack.events[0].content.includes('/opt/homebrew'), `/opt/ path leaked: ${pack.events[0].content}`);
    assert.ok(!pack.events[0].content.includes('/app/packages'), `/app/ path leaked: ${pack.events[0].content}`);
  });

  test('non-string event content does not crash sanitizer (cloud R2 P1-3)', async () => {
    const { sanitizeStoryExport, buildCatIdentityAliases } = await import('../dist/domains/story/content-sanitizer.js');
    const aliases = buildCatIdentityAliases([]);

    // Claude API content blocks are arrays — must not crash .replace()
    const events = [
      {
        id: 'e1',
        at: 1000,
        kind: 'text',
        content: [{ type: 'text', text: 'hello world' }],
        catId: 'opus',
      },
    ];
    // Should not throw TypeError: content.replace is not a function
    const pack = sanitizeStoryExport('s1', 'Test', events, [], aliases);
    assert.strictEqual(typeof pack.events[0].content, 'string');
  });
});
