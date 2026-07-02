import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import crypto from 'node:crypto';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { resolveStartupProjectRoot } from '../../../../../utils/startup-root.js';

const log = createModuleLogger('invaluable-node-manager');

export interface InvaluableNode {
  name: string;
  dataDir: string;
  process: ChildProcess | null;
}

export class InvaluableNodeManager {
  private static instance: InvaluableNodeManager | null = null;
  private readonly nodes: Map<string, InvaluableNode> = new Map();
  private readonly monorepoRoot: string;
  private readonly invaluableRoot: string;
  private readonly buildJsPath: string;

  private constructor() {
    this.monorepoRoot = resolveStartupProjectRoot();
    this.invaluableRoot = resolve(this.monorepoRoot, '../invaluable/invaluable');
    this.buildJsPath = resolve(this.invaluableRoot, 'build/js');

    const nodeNames = ['ict-leo', 'ict-mia', 'ict-ravi', 'ict-niko', 'ict-observer'];
    for (const name of nodeNames) {
      this.nodes.set(name, {
        name,
        dataDir: resolve(this.monorepoRoot, '.loop', name),
        process: null,
      });
    }
  }

  public static getInstance(): InvaluableNodeManager {
    if (!InvaluableNodeManager.instance) {
      InvaluableNodeManager.instance = new InvaluableNodeManager();
    }
    return InvaluableNodeManager.instance;
  }

  /**
   * Pre-generates Ed25519 keys in Invaluable's expected serialization format.
   */
  public provisionNode(name: string): void {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`Unknown node: ${name}`);

    if (!existsSync(node.dataDir)) {
      mkdirSync(node.dataDir, { recursive: true });
    }

    const keyPath = join(node.dataDir, 'identity.key');
    if (existsSync(keyPath)) return;

    log.info(`Provisioning new Ed25519 identity.key for node: ${name}`);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    });

    const publicKeyRaw = publicKey.subarray(12); // last 32 bytes of 44-byte SPKI
    const seed = privateKey.subarray(privateKey.length - 32); // last 32 bytes of PKCS#8
    const secretKey64 = Buffer.concat([seed, publicKeyRaw]); // 64 bytes

    const publicSpki = publicKey.toString('base64url');
    const privateSeed64 = secretKey64.toString('base64url');

    const content = `type=ed25519\npublic=${publicSpki}\nprivate=${privateSeed64}\n`;
    writeFileSync(keyPath, content, 'utf8');
  }

  /**
   * Spawns a background node process if it is not already running.
   */
  public startNode(name: string): void {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`Unknown node: ${name}`);
    if (node.process && !node.process.killed) return;

    this.provisionNode(name);

    const relativeBundlePath = 'packages/invaluable-app-social-mcp/kotlin/invaluable-app-social-mcp.js';
    const bundlePath = resolve(this.buildJsPath, relativeBundlePath);

    if (!existsSync(bundlePath)) {
      throw new Error(`Invaluable Kotlin/JS bundle not found at ${bundlePath}. Please run gradle build first.`);
    }

    log.info(`Spawning background peer node process: ${name}`);
    const child = spawn(
      'node',
      [
        relativeBundlePath,
        '--data-dir', node.dataDir,
        '--name', name,
        '--signal-port', '51900',
        'mcp'
      ],
      {
        cwd: this.buildJsPath,
        env: {
          ...process.env,
          NODE_PATH: 'build/js/node_modules',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );

    child.stderr?.on('data', (data) => {
      log.debug(`[${name}] ${data.toString().trim()}`);
    });

    child.on('exit', (code, signal) => {
      log.warn(`Background peer node ${name} exited with code ${code} (signal ${signal})`);
      if (node.process === child) {
        node.process = null;
      }
    });

    node.process = child;
  }

  /**
   * Kills all background node processes on Clowder shutdown.
   */
  public stopAll(): void {
    for (const name of this.nodes.keys()) {
      const node = this.nodes.get(name);
      if (node && node.process) {
        log.info(`Stopping background peer node process: ${name}`);
        node.process.kill('SIGTERM');
        node.process = null;
      }
    }
  }

  /**
   * Helper to retrieve node status (for tests)
   */
  public getNodeProcess(name: string): ChildProcess | null {
    const node = this.nodes.get(name);
    return node ? node.process : null;
  }

  /**
   * Helper to retrieve node's data directory (for tests)
   */
  public getDataDir(name: string): string {
    const node = this.nodes.get(name);
    return node ? node.dataDir : '';
  }
}
