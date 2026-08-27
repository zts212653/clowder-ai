import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const resultPrefix = 'M0D_RESULT ';
const childFixturePath = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/m0d-standalone-child.mjs');

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolvePromiseValue) => {
    resolvePromise = resolvePromiseValue;
  });
  return { promise, resolve: resolvePromise };
}

export async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ObservedNodeProcessAdapter {
  specs = [];
  children = [];
  diagnostics = [];
  #outcome = deferred();

  constructor(delegate) {
    this.delegate = delegate;
  }

  async spawn(spec) {
    this.specs.push(structuredClone(spec));
    const child = await this.delegate.spawn(spec);
    let pending = '';
    child.stderr.on('data', (chunk) => {
      pending += Buffer.from(chunk).toString('utf8');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline === -1) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.startsWith(resultPrefix)) {
          this.#outcome.resolve(JSON.parse(line.slice(resultPrefix.length)));
        } else if (line.length > 0) {
          this.diagnostics.push(line);
        }
      }
    });
    this.children.push(child);
    return child;
  }

  waitForOutcome(timeoutMs = 2_000) {
    return within(this.#outcome.promise, timeoutMs, 'compiled standalone child emitted no acceptance outcome');
  }
}

export async function stageAcceptancePackage(root, behaviorCase, manifest) {
  const sourceRoot = join(root, 'source');
  const packageRoot = join(sourceRoot, 'package');
  const archivePath = join(sourceRoot, 'package.tgz');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await Promise.all([
    copyFile(childFixturePath, join(packageRoot, 'dist/plugin.js')),
    writeFile(join(packageRoot, 'case.json'), `${JSON.stringify(behaviorCase)}\n`, 'utf8'),
    writeFile(join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8'),
    writeFile(join(packageRoot, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8'),
  ]);
  await execFileAsync('tar', ['czf', archivePath, '-C', sourceRoot, 'package']);
  const bytes = await readFile(archivePath);
  return {
    archivePath,
    packageDigest: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

export async function publishAcceptanceArchive(packagesRoot, archivePath, packageDigest, packageDirectoryName) {
  const artifactRoot = join(packagesRoot, packageDirectoryName(packageDigest));
  await mkdir(artifactRoot, { recursive: true });
  await copyFile(archivePath, join(artifactRoot, 'package.tgz'));
}
