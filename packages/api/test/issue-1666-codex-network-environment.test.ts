/**
 * @fileoverview Tests for Codex network environment derivation (Issue #1666).
 *
 * Test strategy: RED first, then GREEN.
 * - Test pure function behavior with various input combinations
 * - Verify existing proxy/exceptions are preserved
 * - Verify loopback addresses are added correctly
 * - Verify Windows ProxyOverride parsing and safe degradation
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  deriveCodexNetworkEnvironmentSync,
  type WindowsSystemProxyConfig,
} from '../src/utils/codex-network-environment.js';

describe('Issue #1666: Codex network environment derivation', () => {
  describe('No proxy configuration', () => {
    it('adds loopback addresses when no proxy is configured', () => {
      // On Windows, must provide systemProxy to enable safe loopback injection
      const systemProxy: WindowsSystemProxyConfig | undefined =
        process.platform === 'win32' ? { enabled: false, hasPac: false } : undefined;

      const result = deriveCodexNetworkEnvironmentSync({}, systemProxy);

      assert.strictEqual(result.diagnostic.hasProxy, false);
      assert.strictEqual(result.diagnostic.loopbackAdded, true);
      assert.strictEqual(result.diagnostic.exceptionSource, 'none');
      assert.deepStrictEqual(result.diagnostic.unsupportedScenarios, []);

      // Should add NO_PROXY with loopback addresses
      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);
      assert.ok(noProxy.includes('localhost'));
      assert.ok(noProxy.includes('127.0.0.1'));
      assert.ok(noProxy.includes('::1'));
    });
  });

  describe('Proxy with no exceptions', () => {
    it('adds loopback addresses when proxy exists but NO_PROXY is empty', () => {
      // On Windows, must provide systemProxy to enable safe loopback injection
      const systemProxy: WindowsSystemProxyConfig | undefined =
        process.platform === 'win32' ? { enabled: false, hasPac: false } : undefined;

      const result = deriveCodexNetworkEnvironmentSync(
        {
          HTTP_PROXY: 'http://proxy.example.com:8080',
          NO_PROXY: '',
        },
        systemProxy,
      );

      assert.strictEqual(result.diagnostic.hasProxy, true);
      assert.strictEqual(result.diagnostic.loopbackAdded, true);

      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);
      assert.ok(noProxy.includes('localhost'));
      assert.ok(noProxy.includes('127.0.0.1'));
      assert.ok(noProxy.includes('::1'));
    });

    it('adds loopback addresses when proxy exists but NO_PROXY is whitespace', () => {
      // On Windows, must provide systemProxy to enable safe loopback injection
      const systemProxy: WindowsSystemProxyConfig | undefined =
        process.platform === 'win32' ? { enabled: false, hasPac: false } : undefined;

      const result = deriveCodexNetworkEnvironmentSync(
        {
          HTTPS_PROXY: 'http://proxy.example.com:8080',
          NO_PROXY: '   ',
        },
        systemProxy,
      );

      assert.strictEqual(result.diagnostic.hasProxy, true);
      assert.strictEqual(result.diagnostic.loopbackAdded, true);

      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy?.includes('localhost'));
    });
  });

  describe('Preserve existing exceptions', () => {
    it('preserves and appends to existing NO_PROXY', () => {
      const result = deriveCodexNetworkEnvironmentSync({
        HTTP_PROXY: 'http://proxy.example.com:8080',
        NO_PROXY: '10.0.0.0/8,.internal.company.com',
      });

      assert.strictEqual(result.diagnostic.hasProxy, true);
      assert.strictEqual(result.diagnostic.exceptionSource, 'env');
      assert.strictEqual(result.diagnostic.loopbackAdded, true);

      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);

      // Must preserve original exceptions
      assert.ok(noProxy.includes('10.0.0.0/8'));
      assert.ok(noProxy.includes('.internal.company.com'));

      // Must add loopback addresses
      assert.ok(noProxy.includes('localhost'));
      assert.ok(noProxy.includes('127.0.0.1'));
      assert.ok(noProxy.includes('::1'));
    });

    it('does not duplicate existing loopback addresses', () => {
      const result = deriveCodexNetworkEnvironmentSync({
        HTTP_PROXY: 'http://proxy.example.com:8080',
        NO_PROXY: 'localhost,.internal.com',
      });

      assert.strictEqual(result.diagnostic.hasProxy, true);
      assert.strictEqual(result.diagnostic.exceptionSource, 'env');

      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);

      // Should not duplicate localhost
      const parts = noProxy.split(',').map((s) => s.trim());
      const localhostCount = parts.filter((p) => p.toLowerCase() === 'localhost').length;
      assert.strictEqual(localhostCount, 1, 'localhost should appear only once');

      // Should still add other loopback addresses
      assert.ok(noProxy.includes('127.0.0.1'));
      assert.ok(noProxy.includes('::1'));
    });

    it('handles case-insensitive deduplication', () => {
      const result = deriveCodexNetworkEnvironmentSync({
        HTTP_PROXY: 'http://proxy.example.com:8080',
        NO_PROXY: 'LOCALHOST,LocalHost',
      });

      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);

      // Should preserve original casing but not duplicate
      const parts = noProxy.split(',').map((s) => s.trim());
      const localhostVariants = parts.filter((p) => p.toLowerCase() === 'localhost');
      assert.ok(localhostVariants.length >= 1, 'should have at least one localhost variant');
      assert.ok(localhostVariants.length <= 2, 'should not add more localhost variants');
    });
  });

  describe('Handle null deletions', () => {
    it('respects environment where NO_PROXY was explicitly deleted', () => {
      // On Windows, must provide systemProxy to enable safe loopback injection
      const systemProxy: WindowsSystemProxyConfig | undefined =
        process.platform === 'win32' ? { enabled: false, hasPac: false } : undefined;

      const base = {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        // NO_PROXY intentionally missing (was deleted via null override)
      };

      const result = deriveCodexNetworkEnvironmentSync(base, systemProxy);

      assert.strictEqual(result.diagnostic.hasProxy, true);
      assert.strictEqual(result.diagnostic.loopbackAdded, true);

      // Should add NO_PROXY even if it was missing
      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);
      assert.ok(noProxy.includes('localhost'));
    });
  });

  describe('Windows ProxyOverride parsing', () => {
    it('parses simple ProxyOverride list', () => {
      if (process.platform !== 'win32') {
        // Skip on non-Windows
        return;
      }

      const systemProxy: WindowsSystemProxyConfig = {
        enabled: true,
        proxyServer: 'proxy.company.com:8080',
        proxyOverride: '*.local;10.0.0.1;internal.company.com',
        hasPac: false,
      };

      const result = deriveCodexNetworkEnvironmentSync({ HTTP_PROXY: 'http://proxy.company.com:8080' }, systemProxy);

      assert.strictEqual(result.diagnostic.exceptionSource, 'system_static');

      // Should mark wildcard as unsupported
      assert.ok(
        result.diagnostic.unsupportedScenarios.some((s) => s.includes('*.local')),
        'wildcard pattern should be marked unsupported',
      );
    });

    it('preserves environment when ProxyOverride contains <local>', () => {
      if (process.platform !== 'win32') return;

      const systemProxy: WindowsSystemProxyConfig = {
        enabled: true,
        proxyServer: 'proxy.company.com:8080',
        proxyOverride: '<local>;10.0.0.1',
        hasPac: false,
      };

      const result = deriveCodexNetworkEnvironmentSync({ HTTP_PROXY: 'http://proxy.company.com:8080' }, systemProxy);

      assert.strictEqual(result.diagnostic.exceptionSource, 'system_static');
      assert.ok(
        result.diagnostic.unsupportedScenarios.some((s) => s.includes('<local>')),
        '<local> should be marked unsupported',
      );
    });

    it('preserves environment when system proxy read fails', () => {
      if (process.platform !== 'win32') return;

      const result = deriveCodexNetworkEnvironmentSync(
        { HTTP_PROXY: 'http://proxy.company.com:8080' },
        null, // Read failed
      );

      assert.strictEqual(result.diagnostic.exceptionSource, 'read_failed');
      assert.deepStrictEqual(result.diagnostic.unsupportedScenarios, ['windows_system_proxy_read_failed']);

      // Should preserve original environment
      assert.strictEqual(result.env.NO_PROXY, undefined);
      assert.strictEqual(result.env.no_proxy, undefined);
    });

    it('preserves environment when PAC/WPAD is configured', () => {
      if (process.platform !== 'win32') return;

      const systemProxy: WindowsSystemProxyConfig = {
        enabled: true,
        proxyServer: 'proxy.company.com:8080',
        proxyOverride: '10.0.0.1',
        hasPac: true,
      };

      const result = deriveCodexNetworkEnvironmentSync({ HTTP_PROXY: 'http://proxy.company.com:8080' }, systemProxy);

      assert.strictEqual(result.diagnostic.exceptionSource, 'system_pac');
      assert.deepStrictEqual(result.diagnostic.unsupportedScenarios, ['windows_pac_wpad_not_convertible']);

      // Should preserve original environment
      assert.strictEqual(result.env.NO_PROXY, undefined);
    });

    it('merges simple ProxyOverride entries with loopback', () => {
      if (process.platform !== 'win32') return;

      const systemProxy: WindowsSystemProxyConfig = {
        enabled: true,
        proxyServer: 'proxy.company.com:8080',
        proxyOverride: '10.0.0.1;192.168.1.1',
        hasPac: false,
      };

      const result = deriveCodexNetworkEnvironmentSync({ HTTP_PROXY: 'http://proxy.company.com:8080' }, systemProxy);

      assert.strictEqual(result.diagnostic.exceptionSource, 'system_static');
      assert.strictEqual(result.diagnostic.loopbackAdded, true);
      assert.deepStrictEqual(result.diagnostic.unsupportedScenarios, []);

      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);

      // Should include system exceptions
      assert.ok(noProxy.includes('10.0.0.1'));
      assert.ok(noProxy.includes('192.168.1.1'));

      // Should add loopback addresses
      assert.ok(noProxy.includes('localhost'));
      assert.ok(noProxy.includes('127.0.0.1'));
      assert.ok(noProxy.includes('::1'));
    });
  });

  describe('Platform-specific casing', () => {
    it('uses uppercase NO_PROXY on Windows', () => {
      if (process.platform !== 'win32') return;

      const systemProxy: WindowsSystemProxyConfig = { enabled: false, hasPac: false };

      const result = deriveCodexNetworkEnvironmentSync(
        {
          HTTP_PROXY: 'http://proxy.example.com:8080',
        },
        systemProxy,
      );

      assert.ok(result.env.NO_PROXY, 'should set NO_PROXY on Windows');
      assert.strictEqual(result.env.no_proxy, undefined, 'should not set lowercase no_proxy on Windows');
    });

    it('preserves existing casing on Unix', () => {
      if (process.platform === 'win32') return;

      const resultWithUpper = deriveCodexNetworkEnvironmentSync({
        HTTP_PROXY: 'http://proxy.example.com:8080',
        NO_PROXY: 'existing.com',
      });

      assert.ok(resultWithUpper.env.NO_PROXY, 'should preserve uppercase NO_PROXY');

      const resultWithLower = deriveCodexNetworkEnvironmentSync({
        http_proxy: 'http://proxy.example.com:8080',
        no_proxy: 'existing.com',
      });

      assert.ok(resultWithLower.env.no_proxy, 'should preserve lowercase no_proxy');
    });
  });

  describe('Edge cases', () => {
    it('handles empty environment', () => {
      // On Windows, must provide systemProxy to enable safe loopback injection
      const systemProxy: WindowsSystemProxyConfig | undefined =
        process.platform === 'win32' ? { enabled: false, hasPac: false } : undefined;

      const result = deriveCodexNetworkEnvironmentSync({}, systemProxy);

      assert.strictEqual(result.diagnostic.hasProxy, false);
      assert.strictEqual(result.diagnostic.loopbackAdded, true);

      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);
      assert.ok(noProxy.includes('localhost'));
    });

    it('handles ALL_PROXY', () => {
      // On Windows, must provide systemProxy to enable safe loopback injection
      const systemProxy: WindowsSystemProxyConfig | undefined =
        process.platform === 'win32' ? { enabled: false, hasPac: false } : undefined;

      const result = deriveCodexNetworkEnvironmentSync(
        {
          ALL_PROXY: 'http://proxy.example.com:8080',
        },
        systemProxy,
      );

      assert.strictEqual(result.diagnostic.hasProxy, true);
      assert.strictEqual(result.diagnostic.loopbackAdded, true);
    });

    it('handles lowercase proxy variables', () => {
      // On Windows, must provide systemProxy to enable safe loopback injection
      const systemProxy: WindowsSystemProxyConfig | undefined =
        process.platform === 'win32' ? { enabled: false, hasPac: false } : undefined;

      const result = deriveCodexNetworkEnvironmentSync(
        {
          http_proxy: 'http://proxy.example.com:8080',
          https_proxy: 'http://proxy.example.com:8080',
        },
        systemProxy,
      );

      assert.strictEqual(result.diagnostic.hasProxy, true);
      assert.strictEqual(result.diagnostic.loopbackAdded, true);
    });

    it('handles NO_PROXY with only commas', () => {
      // On Windows, must provide systemProxy to enable safe loopback injection
      const systemProxy: WindowsSystemProxyConfig | undefined =
        process.platform === 'win32' ? { enabled: false, hasPac: false } : undefined;

      const result = deriveCodexNetworkEnvironmentSync(
        {
          HTTP_PROXY: 'http://proxy.example.com:8080',
          NO_PROXY: ',,,',
        },
        systemProxy,
      );

      assert.strictEqual(result.diagnostic.hasProxy, true);
      assert.strictEqual(result.diagnostic.loopbackAdded, true);

      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);
      assert.ok(noProxy.includes('localhost'));
    });

    it('preserves wildcard and CIDR in existing NO_PROXY', () => {
      const result = deriveCodexNetworkEnvironmentSync({
        HTTP_PROXY: 'http://proxy.example.com:8080',
        NO_PROXY: '*.internal.com,10.0.0.0/8,192.168.0.0/16',
      });

      assert.strictEqual(result.diagnostic.exceptionSource, 'env');

      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);

      // Must preserve all original patterns
      assert.ok(noProxy.includes('*.internal.com'));
      assert.ok(noProxy.includes('10.0.0.0/8'));
      assert.ok(noProxy.includes('192.168.0.0/16'));

      // Must add loopback
      assert.ok(noProxy.includes('localhost'));
    });
  });

  describe('Invariants', () => {
    it('never modifies input environment', () => {
      const input = {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        NO_PROXY: 'existing.com',
      };
      const inputCopy = { ...input };

      deriveCodexNetworkEnvironmentSync(input);

      assert.deepStrictEqual(input, inputCopy, 'input should not be modified');
    });

    it('always returns new environment object', () => {
      const input = { HTTP_PROXY: 'http://proxy.example.com:8080' };
      const result = deriveCodexNetworkEnvironmentSync(input);

      assert.notStrictEqual(result.env, input, 'should return new object');
    });

    it('does not add NO_PROXY when existing exceptions already cover loopback', () => {
      const result = deriveCodexNetworkEnvironmentSync({
        HTTP_PROXY: 'http://proxy.example.com:8080',
        NO_PROXY: 'localhost,127.0.0.1,::1',
      });

      assert.strictEqual(result.diagnostic.exceptionSource, 'env');

      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);

      const parts = noProxy.split(',').map((s) => s.trim());
      assert.strictEqual(parts.length, 3, 'should not add duplicates');
    });
  });

  describe('Windows system proxy enabled state', () => {
    it('uses system proxy when enabled=true', () => {
      if (process.platform !== 'win32') return;

      const systemProxy: WindowsSystemProxyConfig = {
        enabled: true,
        proxyServer: 'proxy.company.com:8080',
        proxyOverride: '10.0.0.1',
        hasPac: false,
      };

      const result = deriveCodexNetworkEnvironmentSync({}, systemProxy);

      assert.strictEqual(result.diagnostic.exceptionSource, 'system_static');
      assert.strictEqual(result.diagnostic.loopbackAdded, true);
    });

    it('does not use system proxy when enabled=false', () => {
      if (process.platform !== 'win32') return;

      const systemProxy: WindowsSystemProxyConfig = {
        enabled: false,
        proxyServer: 'proxy.company.com:8080',
        proxyOverride: '10.0.0.1',
        hasPac: false,
      };

      const result = deriveCodexNetworkEnvironmentSync({}, systemProxy);

      // Should not use system proxy when disabled
      assert.strictEqual(result.diagnostic.exceptionSource, 'none');
      assert.strictEqual(result.diagnostic.loopbackAdded, true);
    });

    it('handles system proxy read failure (null)', () => {
      if (process.platform !== 'win32') return;

      const result = deriveCodexNetworkEnvironmentSync({}, null);

      assert.strictEqual(result.diagnostic.exceptionSource, 'read_failed');
      assert.deepStrictEqual(result.diagnostic.unsupportedScenarios, ['windows_system_proxy_read_failed']);
    });

    it('handles system proxy read returning undefined', () => {
      const result = deriveCodexNetworkEnvironmentSync({}, undefined);

      // undefined means system proxy reading not attempted (non-Windows or not needed)
      assert.strictEqual(result.diagnostic.exceptionSource, 'none');
    });
  });

  describe('Case-insensitive proxy variable handling', () => {
    it('scans all case variants of NO_PROXY', () => {
      const result = deriveCodexNetworkEnvironmentSync({
        HTTP_PROXY: 'http://proxy.example.com:8080',
        no_proxy: 'lowercase.com',
        No_Proxy: 'mixedcase.com',
      });

      // Should detect proxy from any case variant
      assert.strictEqual(result.diagnostic.hasProxy, true);
      assert.strictEqual(result.diagnostic.exceptionSource, 'env');

      // Should collect entries from all case variants and merge them
      const noProxy = result.env.NO_PROXY ?? result.env.no_proxy;
      assert.ok(noProxy);
      assert.ok(noProxy.includes('lowercase.com'), 'should include lowercase.com from no_proxy');
      assert.ok(noProxy.includes('mixedcase.com'), 'should include mixedcase.com from No_Proxy');
    });

    it('deletes all case variants when setting NO_PROXY', () => {
      if (process.platform !== 'win32') return;

      const input = {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        no_proxy: 'old.com',
        No_Proxy: 'old2.com',
      };

      const systemProxy: WindowsSystemProxyConfig = { enabled: false, hasPac: false };
      const result = deriveCodexNetworkEnvironmentSync(input, systemProxy);

      // Should have canonical NO_PROXY on Windows
      assert.ok(result.env.NO_PROXY);

      // Should delete lowercase variants
      assert.strictEqual(result.env.no_proxy, undefined);
      assert.strictEqual(result.env.No_Proxy, undefined);
    });
  });
});
