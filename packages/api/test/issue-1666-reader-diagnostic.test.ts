import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { deriveCodexNetworkEnvironmentSync, readWindowsSystemProxy } from '../src/utils/codex-network-environment.js';

interface Scenario {
  name: string;
  output: string;
  source: 'none' | 'system_pac' | 'read_failed';
  unsupported: string[];
  loopback: boolean;
  failResolver?: boolean;
}

const unknown = ['windows_system_proxy_read_failed'];
const pac = ['windows_pac_wpad_not_convertible'];
const scenarios: Scenario[] = [
  {
    name: 'known disabled',
    output: '{"autoDetect":false,"autoConfigUrl":null}',
    source: 'none',
    unsupported: [],
    loopback: true,
  },
  {
    name: 'WPAD enabled',
    output: '{"autoDetect":true,"autoConfigUrl":null}',
    source: 'system_pac',
    unsupported: pac,
    loopback: false,
  },
  {
    name: 'connection PAC',
    output: '{"autoDetect":false,"autoConfigUrl":"http://pac.fixture.invalid/config.pac"}',
    source: 'system_pac',
    unsupported: pac,
    loopback: false,
  },
  {
    name: 'unknown flag',
    output: '{"autoDetect":null,"autoConfigUrl":null}',
    source: 'read_failed',
    unsupported: unknown,
    loopback: false,
  },
  { name: 'missing flag', output: '{}', source: 'read_failed', unsupported: unknown, loopback: false },
  {
    name: 'string boolean',
    output: '{"autoDetect":"false"}',
    source: 'read_failed',
    unsupported: unknown,
    loopback: false,
  },
  {
    name: 'API failure',
    output: '{"autoDetect":null,"error":"fixture API error"}',
    source: 'read_failed',
    unsupported: unknown,
    loopback: false,
  },
  { name: 'invalid JSON', output: 'invalid JSON', source: 'read_failed', unsupported: unknown, loopback: false },
  {
    name: 'resolver timeout',
    output: '',
    failResolver: true,
    source: 'read_failed',
    unsupported: unknown,
    loopback: false,
  },
];

test('Windows reader to derive diagnostic source', { skip: process.platform !== 'win32' }, async (t) => {
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const original = childProcess.execFile;
      const commands: string[] = [];
      const stub = Object.assign(
        (): never => {
          throw new Error('The reader must use the promisified fixture');
        },
        {
          [promisify.custom]: async (command: string) => {
            commands.push(command);
            if (command === 'reg') {
              return { stdout: 'HKCU\\Fixture\r\n ProxyEnable REG_DWORD 0x0\r\n', stderr: '' };
            }
            assert.equal(command, 'powershell.exe', 'unexpected command must never execute');
            if (scenario.failResolver) throw new Error('fixture timeout');
            return { stdout: scenario.output, stderr: '' };
          },
        },
      );
      childProcess.execFile = stub as typeof childProcess.execFile;
      syncBuiltinESMExports();
      try {
        const systemProxy = await readWindowsSystemProxy({ timeoutMs: 1000 });
        assert.deepEqual(commands, ['reg', 'powershell.exe'], 'the real reader must query both sources');
        const base = { HTTPS_PROXY: 'http://proxy.fixture.invalid:3128', TEST_VAR: 'kept' };
        const result = deriveCodexNetworkEnvironmentSync(base, systemProxy);
        assert.equal(result.diagnostic.exceptionSource, scenario.source);
        assert.deepEqual(result.diagnostic.unsupportedScenarios, scenario.unsupported);
        assert.equal(result.diagnostic.loopbackAdded, scenario.loopback);
        assert.equal(result.env.HTTPS_PROXY, base.HTTPS_PROXY);
        assert.equal(result.env.TEST_VAR, base.TEST_VAR);
        if (scenario.loopback) {
          assert.deepEqual(new Set(result.env.NO_PROXY?.split(',')), new Set(['localhost', '127.0.0.1', '::1']));
        } else {
          assert.deepEqual(result.env, base, 'unknown and unsupported policies must preserve the environment');
        }
      } finally {
        childProcess.execFile = original;
        syncBuiltinESMExports();
      }
    });
  }
});
