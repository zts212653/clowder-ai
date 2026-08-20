/**
 * clowder-ai#1280: production wiring regression guard.
 *
 * The System branch must retain both the curated projection and the existing
 * Environment & Files surface. Reading the production source catches the
 * exact regression without replacing composition with an isolated fixture.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SETTINGS_CONTENT_PATH = resolve(__dirname, '../SettingsContent.tsx');

function systemBranch(): string {
  const source = readFileSync(SETTINGS_CONTENT_PATH, 'utf8');
  const match = source.match(/case\s+'system':\s*\n\s*return\s*\(\s*\n([\s\S]*?)\n\s*\);/);
  if (!match?.[1]) throw new Error('System settings production branch not found');
  return match[1];
}

describe('System settings production wiring', () => {
  const source = readFileSync(SETTINGS_CONTENT_PATH, 'utf8');

  it('imports both System surfaces', () => {
    expect(source).toContain("from './HubSystemSettingsTab'");
    expect(source).toContain("from '../HubEnvFilesTab'");
  });

  it('renders both System surfaces in the production branch', () => {
    const branch = systemBranch();
    expect(branch).toContain('<HubSystemSettingsTab');
    expect(branch).toContain('<HubEnvFilesTab');
  });
});
