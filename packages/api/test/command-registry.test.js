import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// Will fail until CommandRegistry is implemented
import { CommandRegistry } from '../dist/infrastructure/commands/CommandRegistry.js';

const CORE_COMMANDS = [
  { name: '/help', usage: '/help', description: 'Show help', category: 'general', surface: 'both', source: 'core' },
  {
    name: '/where',
    usage: '/where',
    description: 'Show binding',
    category: 'connector',
    surface: 'connector',
    source: 'core',
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
];

describe('CommandRegistry', () => {
  it('registers core commands on construction', () => {
    const registry = new CommandRegistry(CORE_COMMANDS);
    assert.ok(registry.has('/help'));
    assert.ok(registry.has('/where'));
    assert.ok(registry.has('/config'));
    assert.ok(!registry.has('/unknown'));
  });

  it('get() returns the definition', () => {
    const registry = new CommandRegistry(CORE_COMMANDS);
    const def = registry.get('/help');
    assert.ok(def);
    assert.equal(def.name, '/help');
    assert.equal(def.source, 'core');
  });

  it('getAll() returns all registered commands', () => {
    const registry = new CommandRegistry(CORE_COMMANDS);
    assert.equal(registry.getAll().length, 3);
  });

  it('listBySurface("connector") returns connector + both', () => {
    const registry = new CommandRegistry(CORE_COMMANDS);
    const cmds = registry.listBySurface('connector');
    const names = cmds.map((c) => c.name).sort();
    // /help is 'both', /where is 'connector', /config is 'web' (excluded)
    assert.deepEqual(names, ['/help', '/where']);
  });

  it('listBySurface("web") returns web + both', () => {
    const registry = new CommandRegistry(CORE_COMMANDS);
    const cmds = registry.listBySurface('web');
    const names = cmds.map((c) => c.name).sort();
    assert.deepEqual(names, ['/config', '/help']);
  });

  it('registerSkillCommands adds skill commands', () => {
    const registry = new CommandRegistry(CORE_COMMANDS);
    const warnings = [];
    registry.registerSkillCommands(
      'debugging',
      [
        {
          name: '/debug',
          usage: '/debug',
          description: 'Debug',
          category: 'general',
          surface: 'connector',
          source: 'skill',
        },
      ],
      { warn: (msg) => warnings.push(msg) },
    );
    assert.ok(registry.has('/debug'));
    const def = registry.get('/debug');
    assert.equal(def.source, 'skill');
    assert.equal(def.skillId, 'debugging');
    assert.equal(warnings.length, 0);
  });

  it('rejects skill command that conflicts with core (AC-B2)', () => {
    const registry = new CommandRegistry(CORE_COMMANDS);
    const warnings = [];
    registry.registerSkillCommands(
      'rogue-skill',
      [
        {
          name: '/help',
          usage: '/help',
          description: 'Hijack help',
          category: 'general',
          surface: 'both',
          source: 'skill',
        },
      ],
      { warn: (msg) => warnings.push(msg) },
    );
    // /help should still be core
    assert.equal(registry.get('/help').source, 'core');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('rogue-skill'));
    assert.ok(warnings[0].includes('/help'));
  });

  it('rejects skill command that conflicts with another skill', () => {
    const registry = new CommandRegistry(CORE_COMMANDS);
    const warnings = [];
    registry.registerSkillCommands(
      'skill-a',
      [
        {
          name: '/deploy',
          usage: '/deploy',
          description: 'Deploy A',
          category: 'general',
          surface: 'connector',
          source: 'skill',
        },
      ],
      { warn: (msg) => warnings.push(msg) },
    );
    registry.registerSkillCommands(
      'skill-b',
      [
        {
          name: '/deploy',
          usage: '/deploy',
          description: 'Deploy B',
          category: 'general',
          surface: 'connector',
          source: 'skill',
        },
      ],
      { warn: (msg) => warnings.push(msg) },
    );
    // First registration wins
    assert.equal(registry.get('/deploy').skillId, 'skill-a');
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('skill-b'));
  });

  it('rejects skill with subcommand that overlaps core flat name (P2-1 fix)', () => {
    // Core has '/tasks extract' as flat name
    const core = [
      {
        name: '/tasks extract',
        usage: '/tasks extract [N]',
        description: 'Extract tasks',
        category: 'task',
        surface: 'web',
        source: 'core',
      },
    ];
    const registry = new CommandRegistry(core);
    const warnings = [];
    // Skill tries to register '/tasks' with subcommand 'extract' — semantic conflict
    registry.registerSkillCommands(
      'task-skill',
      [
        {
          name: '/tasks',
          usage: '/tasks',
          description: 'Tasks',
          category: 'general',
          surface: 'connector',
          source: 'skill',
          subcommands: ['extract'],
        },
      ],
      { warn: (msg) => warnings.push(msg) },
    );
    assert.ok(warnings.length >= 1, 'should warn about semantic conflict with /tasks extract');
    assert.ok(
      warnings.some((w) => w.includes('/tasks extract')),
      'warning should mention the conflicting expanded form',
    );
  });

  it('listBySurface includes skill commands', () => {
    const registry = new CommandRegistry(CORE_COMMANDS);
    registry.registerSkillCommands(
      'debugging',
      [
        {
          name: '/debug',
          usage: '/debug',
          description: 'Debug',
          category: 'general',
          surface: 'connector',
          source: 'skill',
        },
      ],
      { warn: () => {} },
    );
    const cmds = registry.listBySurface('connector');
    const names = cmds.map((c) => c.name).sort();
    assert.ok(names.includes('/debug'));
  });
});
