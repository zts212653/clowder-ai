// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(testDir, '..', 'HubMemberOverviewCard.tsx'), 'utf8');

describe('HubMemberOverviewCard action isolation', () => {
  it('toggle onClick calls stopPropagation to prevent row edit', () => {
    expect(src).toMatch(/SettingsResourceToggleSwitch[\s\S]*?onClick=\{[\s\S]*?stopPropagation/);
  });

  it('delete onClick calls stopPropagation to prevent row edit', () => {
    expect(src).toMatch(/SettingsResourceIconButton[\s\S]*?onClick=\{[\s\S]*?stopPropagation/);
  });

  it('codex cats show the effective carrier (APP SERVER) instead of the raw transport family', () => {
    expect(src).toMatch(/codexCarrier\?\.effective === 'app_server'/);
    expect(src).toContain("'APP SERVER'");
  });

  it('ACP takes precedence over the carrier badge (assembly checks getAcpConfig first)', () => {
    expect(src).toMatch(/adapterMode === 'acp'\s*\?\s*'ACP'/);
  });
});
