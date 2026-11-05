import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { type Check, expect, type Socket } from './probe-check.js';
import { type ProbeHost, startProbeHost } from './probe-host.js';

/** F306: native readOnly sandbox reads, denies writes, and denies network (loopback included). */
export async function probeReadonlySandbox(
  binary: string,
  root: string,
  socket: Socket,
  check: Check,
  hosts: ProbeHost[],
): Promise<void> {
  const home = join(root, 'home');
  const work = join(root, 'work');
  await mkdir(home);
  await mkdir(work);
  await writeFile(join(home, 'config.toml'), 'cli_auth_credentials_store="file"\n');
  let connections = 0;
  const listener = createServer((socket) => {
    connections += 1;
    socket.end();
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  try {
    const address = listener.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const host = await startProbeHost(binary, {
      home,
      sqliteHome: home,
      cwd: home,
      name: 'readonly',
      socketPath: socket(),
      configArgs: ['--config', 'mcp_servers={}', '--config', 'apps._default.enabled=false'],
    });
    hosts.push(host);
    let sequence = 0;
    const exec = async (command: string) =>
      host.rpc('command/exec', {
        command: ['/bin/bash', '--noprofile', '--norc', '-c', command],
        cwd: work,
        env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C', LC_ALL: 'C' },
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        timeoutMs: 5000,
        outputBytesCap: 4096,
        processId: `compat-readonly-${++sequence}`,
      });
    await check('readonly.exec_runs', async () => {
      const result = await exec('echo READ_OK');
      expect(
        result.exitCode === 0 && String(result.stdout).includes('READ_OK'),
        `exec result ${JSON.stringify(result)}`,
      );
    });
    await check('readonly.write_denied', async () => {
      const target = join(work, 'written');
      const result = await exec(`echo x > '${target}'`);
      expect(result.exitCode !== 0 && !existsSync(target), 'readOnly sandbox allowed a write');
    });
    await check('readonly.network_denied', async () => {
      const result = await exec(`exec 3<>/dev/tcp/127.0.0.1/${port} && echo NET_OK`);
      expect(result.exitCode !== 0 && connections === 0, 'readOnly sandbox allowed a network connection');
    });
    await host.stop();
  } finally {
    listener.close();
  }
}
