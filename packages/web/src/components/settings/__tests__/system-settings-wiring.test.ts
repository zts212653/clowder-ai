/**
 * #770: Production wiring regression guard.
 *
 * Ensures the `system` section of SettingsContent renders BOTH:
 * 1. HubSystemSettingsTab (curated read-only view)
 * 2. HubEnvFilesTab (full environment editor)
 *
 * This is a source-level guard — it reads the actual SettingsContent source
 * and checks that both component references appear in the system case block.
 * This is more durable than a render test (which would need to mock the entire
 * settings infrastructure) and catches the exact regression pattern: someone
 * removing one surface from the composition.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SETTINGS_CONTENT_PATH = resolve(__dirname, '../SettingsContent.tsx');

describe('#770: system settings production wiring', () => {
  const source = readFileSync(SETTINGS_CONTENT_PATH, 'utf8');

  it('imports HubSystemSettingsTab', () => {
    expect(source).toContain("from './HubSystemSettingsTab'");
  });

  it('imports HubEnvFilesTab', () => {
    expect(source).toContain("from '../HubEnvFilesTab'");
  });

  it('system case renders HubSystemSettingsTab', () => {
    // Extract the system case block
    const systemCaseMatch = source.match(/case\s+'system':\s*\n\s*return\s*\(\s*\n([\s\S]*?)\n\s*\);/);
    expect(systemCaseMatch).toBeTruthy();
    const systemBlock = systemCaseMatch![1];
    expect(systemBlock).toContain('<HubSystemSettingsTab');
  });

  it('system case renders HubEnvFilesTab', () => {
    const systemCaseMatch = source.match(/case\s+'system':\s*\n\s*return\s*\(\s*\n([\s\S]*?)\n\s*\);/);
    expect(systemCaseMatch).toBeTruthy();
    const systemBlock = systemCaseMatch![1];
    expect(systemBlock).toContain('<HubEnvFilesTab');
  });

  it('both surfaces are present (not just one)', () => {
    // Double-check: the system block must contain BOTH, not either
    const systemCaseMatch = source.match(/case\s+'system':\s*\n\s*return\s*\(\s*\n([\s\S]*?)\n\s*\);/);
    expect(systemCaseMatch).toBeTruthy();
    const systemBlock = systemCaseMatch![1];
    const hasSystemTab = systemBlock.includes('<HubSystemSettingsTab');
    const hasEnvTab = systemBlock.includes('<HubEnvFilesTab');
    expect(hasSystemTab && hasEnvTab).toBe(true);
  });
});
