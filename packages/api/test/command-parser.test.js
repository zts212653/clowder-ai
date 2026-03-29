import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// These imports will fail until we implement the shared module
import { ManifestSlashCommandSchema, ManifestSlashCommandsSchema, parseCommand } from '@cat-cafe/shared';

// --- Parser Tests ---

describe('parseCommand', () => {
  const registry = [
    { name: '/help', usage: '/help', description: 'Show help', category: 'general', surface: 'both', source: 'core' },
    {
      name: '/new',
      usage: '/new [title]',
      description: 'Create thread',
      category: 'connector',
      surface: 'connector',
      source: 'core',
    },
    {
      name: '/signals',
      usage: '/signals',
      description: 'Signal inbox',
      category: 'knowledge',
      surface: 'both',
      source: 'core',
      subcommands: ['search', 'sources', 'stats'],
    },
    {
      name: '/config',
      usage: '/config',
      description: 'Config',
      category: 'general',
      surface: 'web',
      source: 'core',
      subcommands: ['set'],
    },
    {
      name: '/debug',
      usage: '/debug <issue>',
      description: 'Debug a bug',
      category: 'general',
      surface: 'connector',
      source: 'skill',
      skillId: 'debugging',
    },
  ];

  it('parses a basic command with no args', () => {
    const result = parseCommand('/help', registry);
    assert.ok(result);
    assert.equal(result.name, '/help');
    assert.equal(result.args, '');
    assert.equal(result.subcommand, undefined);
    assert.equal(result.raw, '/help');
  });

  it('parses a command with args', () => {
    const result = parseCommand('/new hello world', registry);
    assert.ok(result);
    assert.equal(result.name, '/new');
    assert.equal(result.args, 'hello world');
    assert.equal(result.subcommand, undefined);
  });

  it('matches subcommand (longest match)', () => {
    const result = parseCommand('/signals search cats', registry);
    assert.ok(result);
    assert.equal(result.name, '/signals');
    assert.equal(result.subcommand, 'search');
    assert.equal(result.args, 'cats');
  });

  it('matches base command when no subcommand matches', () => {
    const result = parseCommand('/signals', registry);
    assert.ok(result);
    assert.equal(result.name, '/signals');
    assert.equal(result.subcommand, undefined);
    assert.equal(result.args, '');
  });

  it('matches /config set as subcommand', () => {
    const result = parseCommand('/config set theme dark', registry);
    assert.ok(result);
    assert.equal(result.name, '/config');
    assert.equal(result.subcommand, 'set');
    assert.equal(result.args, 'theme dark');
  });

  it('returns null for non-command input', () => {
    assert.equal(parseCommand('hello world', registry), null);
  });

  it('returns null for unknown command', () => {
    assert.equal(parseCommand('/unknown', registry), null);
  });

  it('returns null for empty input', () => {
    assert.equal(parseCommand('', registry), null);
  });

  it('returns null for uppercase command (commands are lowercase)', () => {
    assert.equal(parseCommand('/HELP', registry), null);
  });

  it('trims whitespace before parsing', () => {
    const result = parseCommand('  /help  ', registry);
    assert.ok(result);
    assert.equal(result.name, '/help');
  });

  it('attaches the matched definition', () => {
    const result = parseCommand('/debug my API is broken', registry);
    assert.ok(result);
    assert.equal(result.definition?.source, 'skill');
    assert.equal(result.definition?.skillId, 'debugging');
  });

  it('does not match /helping (must be exact or followed by space)', () => {
    assert.equal(parseCommand('/helping', registry), null);
  });

  it('handles /signals with unknown subcommand as base + args', () => {
    const result = parseCommand('/signals unknown-thing', registry);
    assert.ok(result);
    assert.equal(result.name, '/signals');
    assert.equal(result.subcommand, undefined);
    assert.equal(result.args, 'unknown-thing');
  });

  // P1-2 regression: flat multi-word names (e.g. CORE_COMMANDS style)
  it('longest match with flat multi-word names (P1-2 fix)', () => {
    const flat = [
      {
        name: '/config',
        usage: '/config',
        description: 'Config panel',
        category: 'general',
        surface: 'web',
        source: 'core',
      },
      {
        name: '/config set',
        usage: '/config set <k> <v>',
        description: 'Set config',
        category: 'general',
        surface: 'web',
        source: 'core',
      },
      {
        name: '/signals',
        usage: '/signals',
        description: 'Inbox',
        category: 'knowledge',
        surface: 'web',
        source: 'core',
      },
      {
        name: '/signals search',
        usage: '/signals search <q>',
        description: 'Search',
        category: 'knowledge',
        surface: 'web',
        source: 'core',
      },
      {
        name: '/signals sources',
        usage: '/signals sources',
        description: 'Sources',
        category: 'knowledge',
        surface: 'web',
        source: 'core',
      },
    ];
    // /config set must match '/config set', not '/config' + args='set ...'
    const r1 = parseCommand('/config set theme dark', flat);
    assert.ok(r1);
    assert.equal(r1.name, '/config set', '/config set must match the full multi-word name');
    assert.equal(r1.args, 'theme dark');

    // /signals search must match '/signals search', not '/signals' + args='search ...'
    const r2 = parseCommand('/signals search cats', flat);
    assert.ok(r2);
    assert.equal(r2.name, '/signals search', '/signals search must match the full multi-word name');
    assert.equal(r2.args, 'cats');

    // /signals alone still matches '/signals'
    const r3 = parseCommand('/signals', flat);
    assert.ok(r3);
    assert.equal(r3.name, '/signals');

    // /config alone still matches '/config'
    const r4 = parseCommand('/config', flat);
    assert.ok(r4);
    assert.equal(r4.name, '/config');
  });
});

// --- Schema Tests ---

describe('ManifestSlashCommandSchema', () => {
  it('validates a minimal valid command', () => {
    const result = ManifestSlashCommandSchema.safeParse({
      name: '/debug',
      description: 'Debug a bug',
    });
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
    assert.equal(result.data.surface, 'connector'); // default
  });

  it('validates a full command with all fields', () => {
    const result = ManifestSlashCommandSchema.safeParse({
      name: '/game',
      usage: '/game werewolf',
      description: 'Start a game',
      surface: 'both',
      subcommands: ['status', 'end'],
    });
    assert.ok(result.success);
    assert.deepEqual(result.data.subcommands, ['status', 'end']);
  });

  it('rejects name without leading slash', () => {
    const result = ManifestSlashCommandSchema.safeParse({
      name: 'debug',
      description: 'No slash',
    });
    assert.ok(!result.success);
  });

  it('rejects uppercase name', () => {
    const result = ManifestSlashCommandSchema.safeParse({
      name: '/Debug',
      description: 'Uppercase',
    });
    assert.ok(!result.success);
  });

  it('rejects name longer than 32 chars', () => {
    const result = ManifestSlashCommandSchema.safeParse({
      name: '/' + 'a'.repeat(32),
      description: 'Too long',
    });
    assert.ok(!result.success);
  });

  it('rejects description over 200 characters', () => {
    const result = ManifestSlashCommandSchema.safeParse({
      name: '/test',
      description: 'x'.repeat(201),
    });
    assert.ok(!result.success);
  });

  it('rejects HTML in description', () => {
    const result = ManifestSlashCommandSchema.safeParse({
      name: '/test',
      description: '<script>alert(1)</script>',
    });
    assert.ok(!result.success);
  });

  it('rejects HTML tags in description', () => {
    const result = ManifestSlashCommandSchema.safeParse({
      name: '/test',
      description: 'Click <a href="x">here</a>',
    });
    assert.ok(!result.success);
  });

  it('accepts plain text with angle brackets in non-tag context', () => {
    // "value > 5" should be OK — it's not an HTML tag
    const result = ManifestSlashCommandSchema.safeParse({
      name: '/test',
      description: 'Filter where value > 5',
    });
    assert.ok(result.success);
  });

  it('validates subcommand names', () => {
    const result = ManifestSlashCommandSchema.safeParse({
      name: '/test',
      description: 'Test',
      subcommands: ['good', 'BAD'],
    });
    assert.ok(!result.success);
  });
});

describe('ManifestSlashCommandsSchema (array)', () => {
  it('validates an array of commands', () => {
    const result = ManifestSlashCommandsSchema.safeParse([
      { name: '/debug', description: 'Debug' },
      { name: '/deploy', description: 'Deploy', surface: 'both' },
    ]);
    assert.ok(result.success);
    assert.equal(result.data.length, 2);
  });

  it('rejects if any command is invalid', () => {
    const result = ManifestSlashCommandsSchema.safeParse([
      { name: '/good', description: 'OK' },
      { name: 'bad', description: 'No slash' },
    ]);
    assert.ok(!result.success);
  });
});
