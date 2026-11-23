/**
 * F12: Registry tests — command-registry
 */
import { describe, expect, it } from 'vitest';
import { COMMAND_CATEGORIES, COMMANDS, type CommandCategory } from '../command-registry';

describe('command-registry', () => {
  it('exports at least 10 commands', () => {
    expect(COMMANDS.length).toBeGreaterThanOrEqual(10);
  });

  it('has no duplicate command names', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every command has a valid category', () => {
    const validCategories = Object.keys(COMMAND_CATEGORIES) as CommandCategory[];
    for (const cmd of COMMANDS) {
      expect(validCategories).toContain(cmd.category);
    }
  });

  it('every command has non-empty usage and description', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.usage.length).toBeGreaterThan(0);
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });

  it('includes /help, /config, and /signals', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain('/help');
    expect(names).toContain('/config');
    expect(names).toContain('/signals');
  });

  // F142-B: surface + source fields
  it('every command has valid surface and source (AC-B8)', () => {
    const validSurfaces = ['web', 'connector', 'both'];
    const validSources = ['core', 'skill', 'mcp'];
    for (const cmd of COMMANDS) {
      expect(validSurfaces).toContain(cmd.surface);
      expect(validSources).toContain(cmd.source);
    }
  });
});
