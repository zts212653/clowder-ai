import { execSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { BridgeConnection } from './AntigravityBridge.js';

const log = createModuleLogger('antigravity-discovery');

function probe(conn: BridgeConnection): Promise<void> {
  const mod = conn.useTls ? https : http;
  const protocol = conn.useTls ? 'https' : 'http';
  const url = `${protocol}://127.0.0.1:${conn.port}/exa.language_server_pb.LanguageServerService/GetUserStatus`;
  const body = '{}';

  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-codeium-csrf-token': conn.csrfToken,
        },
        rejectUnauthorized: false,
        timeout: 5_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          res.statusCode === 200 ? resolve() : reject(new Error(`${res.statusCode}: ${data.slice(0, 100)}`));
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('probe timeout'));
    });
    req.write(body);
    req.end();
  });
}

export async function discoverAntigravityLS(): Promise<BridgeConnection> {
  const envPort = process.env['ANTIGRAVITY_PORT'];
  const envCsrf = process.env['ANTIGRAVITY_CSRF_TOKEN'];
  if (envPort && envCsrf) {
    const useTls = process.env['ANTIGRAVITY_TLS'] !== 'false';
    log.info(`using env config: port=${envPort}, tls=${useTls}`);
    return { port: Number(envPort), csrfToken: envCsrf, useTls };
  }

  const psOutput = execSync('ps -eo pid,args 2>/dev/null | grep language_server | grep csrf_token | grep -v grep', {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();

  if (!psOutput) throw new Error('No Antigravity Language Server process found');

  for (const line of psOutput.split('\n')) {
    const csrfMatch = line.match(/--csrf_token\s+(\S+)/);
    const extPortMatch = line.match(/--extension_server_port\s+(\d+)/);
    const pidMatch = line.match(/^\s*(\d+)/);
    if (!csrfMatch || !pidMatch) continue;

    const csrf = csrfMatch[1];
    const pid = pidMatch[1];
    const extPort = extPortMatch ? Number(extPortMatch[1]) : 0;

    const lsofOutput = execSync(`lsof -a -iTCP -sTCP:LISTEN -P -n -p ${pid} 2>/dev/null | grep LISTEN`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    for (const lsofLine of lsofOutput.split('\n')) {
      const portMatch = lsofLine.match(/:(\d+)\s/);
      if (!portMatch) continue;
      const port = Number(portMatch[1]);
      if (port === extPort) continue;

      for (const useTls of [true, false] as const) {
        try {
          await probe({ port, csrfToken: csrf, useTls });
          log.info(`discovered LS: port=${port}, tls=${useTls}, pid=${pid}`);
          return { port, csrfToken: csrf, useTls };
        } catch {
          /* try next */
        }
      }
    }
  }
  throw new Error('Could not discover Antigravity Language Server ConnectRPC port');
}
