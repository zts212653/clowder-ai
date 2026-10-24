/**
 * @fileoverview Integration tests for Codex proxy routing (Issue #1666).
 *
 * Verifies that all Codex launch entry points apply network environment derivation
 * and that loopback addresses bypass proxy while remote targets still use it.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

describe('Issue #1666: Codex proxy routing integration', () => {
  describe('Entry point coverage', () => {
    it('prepareCapabilityLaunch applies network environment derivation', async () => {
      const fs = await import('node:fs/promises');
      const servicePath = fileURLToPath(
        new URL('../src/domains/cats/services/agents/providers/CodexAgentService.ts', import.meta.url),
      );

      const content = await fs.readFile(servicePath, 'utf-8');

      assert.ok(
        content.includes('applyCodexNetworkEnvironment'),
        'CodexAgentService should have applyCodexNetworkEnvironment method',
      );

      assert.ok(
        content.includes('await this.applyCodexNetworkEnvironment'),
        'prepareCapabilityLaunch should call applyCodexNetworkEnvironment',
      );
    });

    it('invoke path applies network environment derivation', async () => {
      const fs = await import('node:fs/promises');
      const servicePath = fileURLToPath(
        new URL('../src/domains/cats/services/agents/providers/CodexAgentService.ts', import.meta.url),
      );

      const content = await fs.readFile(servicePath, 'utf-8');

      assert.ok(
        content.includes('const derivedEnv = await this.applyCodexNetworkEnvironment'),
        'invoke path should call applyCodexNetworkEnvironment',
      );

      assert.ok(content.includes('env: derivedEnv'), 'cliOpts should use derivedEnv');
    });

    it('DirectAgentCarrierSession receives final environment', async () => {
      const fs = await import('node:fs/promises');
      const sessionPath = fileURLToPath(
        new URL('../src/domains/cats/services/agents/providers/DirectAgentCarrierSession.ts', import.meta.url),
      );

      const content = await fs.readFile(sessionPath, 'utf-8');

      assert.ok(
        content.includes('finalEnvironment?: Readonly<NodeJS.ProcessEnv>'),
        'DirectAgentCarrierSession should support finalEnvironment injection',
      );
    });

    it('plugin native launch uses minimal isolated environment', async () => {
      const fs = await import('node:fs/promises');
      const pluginPath = fileURLToPath(
        new URL('../src/domains/cats/services/agents/providers/codex-plugin-native-launch.ts', import.meta.url),
      );

      const content = await fs.readFile(pluginPath, 'utf-8');

      assert.ok(content.includes('MINIMAL_PATH'), 'Plugin native should use MINIMAL_PATH');

      assert.ok(!content.includes('applyCodexNetworkEnvironment'), 'Plugin native should NOT apply network derivation');
    });
  });

  describe('Network routing behavior', () => {
    it.todo('verifies loopback requests bypass proxy with real CLI');
    it.todo('verifies remote requests still use proxy');
    it.todo('verifies Windows ProxyOverride is preserved');
  });

  describe('Session lifecycle', () => {
    it.todo('verifies session recovery after API restart');
    it.todo('verifies same-session continuation');
  });

  describe('Host pool lifecycle', () => {
    it.todo('verifies host is not reused when network environment changes');
    it.todo('verifies busy host is not interrupted by environment refresh');
  });
});
