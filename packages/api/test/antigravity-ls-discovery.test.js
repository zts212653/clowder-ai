import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  discoverAntigravityLS,
  parsePortsJson,
  parseProcessesJson,
} from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-ls-discovery.js';

describe('antigravity-ls-discovery', () => {
  const ENV_KEYS = ['ANTIGRAVITY_PORT', 'ANTIGRAVITY_CSRF_TOKEN', 'ANTIGRAVITY_TLS'];
  const saved = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('parseProcessesJson', () => {
    test('parses single PowerShell object output', () => {
      const json = '{"pid":13360,"cmd":"language_server.exe --csrf_token abc"}';
      assert.deepEqual(parseProcessesJson(json), [{ pid: '13360', cmd: 'language_server.exe --csrf_token abc' }]);
    });

    test('parses array output', () => {
      const json = '[{"pid":1,"cmd":"a"},{"pid":2,"cmd":"b"}]';
      const result = parseProcessesJson(json);
      assert.equal(result.length, 2);
      assert.equal(result[0].pid, '1');
      assert.equal(result[1].cmd, 'b');
    });

    test('drops items missing pid or cmd', () => {
      const json = '[{"pid":1,"cmd":"a"},{"pid":2},{"cmd":"orphan"}]';
      const result = parseProcessesJson(json);
      assert.equal(result.length, 1);
      assert.equal(result[0].pid, '1');
    });

    test('returns [] on invalid JSON', () => {
      assert.deepEqual(parseProcessesJson('not-json'), []);
      assert.deepEqual(parseProcessesJson(''), []);
    });

    test('coerces numeric pid to string', () => {
      const result = parseProcessesJson('{"pid":42,"cmd":"x"}');
      assert.equal(typeof result[0].pid, 'string');
      assert.equal(result[0].pid, '42');
    });
  });

  describe('parsePortsJson', () => {
    test('parses single number', () => {
      assert.deepEqual(parsePortsJson('50781'), [50781]);
    });

    test('parses array of numbers', () => {
      assert.deepEqual(parsePortsJson('[50781,50782]'), [50781, 50782]);
    });

    test('returns [] on invalid input', () => {
      assert.deepEqual(parsePortsJson('not-json'), []);
      assert.deepEqual(parsePortsJson('"text"'), []);
      assert.deepEqual(parsePortsJson(''), []);
    });

    test('filters out non-finite values', () => {
      assert.deepEqual(parsePortsJson('[80,null,"x",443]'), [80, 443]);
    });
  });

  describe('discoverAntigravityLS env shortcut', () => {
    test('returns env config when port + csrf both set', async () => {
      process.env.ANTIGRAVITY_PORT = '12345';
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'env-token';
      process.env.ANTIGRAVITY_TLS = 'false';

      const conn = await discoverAntigravityLS();

      assert.deepEqual(conn, { port: 12345, csrfToken: 'env-token', useTls: false });
    });

    test('TLS defaults to true when ANTIGRAVITY_TLS missing', async () => {
      process.env.ANTIGRAVITY_PORT = '12345';
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'env-token';

      const conn = await discoverAntigravityLS();

      assert.equal(conn.useTls, true);
    });

    test('falls through to discovery when only one env var set', async () => {
      process.env.ANTIGRAVITY_PORT = '12345';
      // ANTIGRAVITY_CSRF_TOKEN missing → must run discovery
      let calledLister = false;
      await assert.rejects(
        discoverAntigravityLS({
          platform: 'win32',
          listProcesses: () => {
            calledLister = true;
            return [];
          },
        }),
        /No Antigravity Language Server process found/,
      );
      assert.equal(calledLister, true);
    });
  });

  describe('discoverAntigravityLS with dependency injection', () => {
    test('selects PowerShell listers on win32 by default (signature)', async () => {
      let psListProcessesCalled = false;
      let psListPortsCalled = false;

      await discoverAntigravityLS({
        platform: 'win32',
        listProcesses: () => {
          psListProcessesCalled = true;
          return [{ pid: '13360', cmd: '--csrf_token tok --extension_server_port 50777' }];
        },
        listListenPorts: (pid) => {
          psListPortsCalled = true;
          assert.equal(pid, '13360');
          return [50781];
        },
        probe: async () => {
          /* succeed on first probe */
        },
      });

      assert.equal(psListProcessesCalled, true);
      assert.equal(psListPortsCalled, true);
    });

    test('parses csrf_token + extension_server_port from cmd line', async () => {
      const conn = await discoverAntigravityLS({
        platform: 'win32',
        listProcesses: () => [
          {
            pid: '13360',
            cmd: 'C:\\language_server_windows_x64.exe --csrf_token b53c1c60-aaa --extension_server_port 50777 --app_data_dir antigravity',
          },
        ],
        listListenPorts: () => [50777, 50781, 50782],
        probe: async ({ port, useTls }) => {
          if (port === 50781 && useTls === true) return;
          throw new Error('skip');
        },
      });

      assert.deepEqual(conn, {
        port: 50781,
        csrfToken: 'b53c1c60-aaa',
        useTls: true,
      });
    });

    test('skips extension_server_port when probing', async () => {
      const probedPorts = [];

      await assert.rejects(
        discoverAntigravityLS({
          platform: 'linux',
          listProcesses: () => [{ pid: '1', cmd: '--csrf_token tok --extension_server_port 9999' }],
          listListenPorts: () => [9999],
          probe: async ({ port }) => {
            probedPorts.push(port);
            throw new Error('nope');
          },
        }),
        /Could not discover/,
      );

      assert.deepEqual(probedPorts, [], 'extension_server_port must not be probed');
    });

    test('falls back to non-TLS when TLS probe fails', async () => {
      const conn = await discoverAntigravityLS({
        platform: 'linux',
        listProcesses: () => [{ pid: '1', cmd: '--csrf_token tok' }],
        listListenPorts: () => [8080],
        probe: async ({ useTls }) => {
          if (useTls) throw new Error('TLS handshake fail');
        },
      });

      assert.deepEqual(conn, { port: 8080, csrfToken: 'tok', useTls: false });
    });

    test('throws when no processes found', async () => {
      await assert.rejects(
        discoverAntigravityLS({
          platform: 'win32',
          listProcesses: () => [],
        }),
        /No Antigravity Language Server process found/,
      );
    });

    test('skips processes without csrf_token in cmd line', async () => {
      await assert.rejects(
        discoverAntigravityLS({
          platform: 'win32',
          listProcesses: () => [
            { pid: '1', cmd: '--no-csrf-here' },
            { pid: '2', cmd: '--app_data_dir foo' },
          ],
          listListenPorts: () => [8080],
          probe: async () => {
            /* should never be called */
            throw new Error('should not probe');
          },
        }),
        /Could not discover/,
      );
    });

    test('tries multiple processes in order', async () => {
      const conn = await discoverAntigravityLS({
        platform: 'linux',
        listProcesses: () => [
          { pid: '1', cmd: '--csrf_token tok-A' },
          { pid: '2', cmd: '--csrf_token tok-B' },
        ],
        listListenPorts: (pid) => (pid === '2' ? [9090] : []),
        probe: async () => {
          /* succeed */
        },
      });

      assert.equal(conn.csrfToken, 'tok-B');
      assert.equal(conn.port, 9090);
    });
  });
});
