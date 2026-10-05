import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { NodeExternalPluginProcessAdapter } from '../external-runtime/node-process-adapter.js';

interface Options {
  readonly desktopRoot: string;
  readonly cacheRoot: string;
  readonly run?: (stage: 'dependencies' | 'electron', directory: string) => Promise<void>;
}

/** Installs the Host's existing pinned Electron component, never a plugin executable.
 * Runs only after an explicit official-package install has verified its archive.
 * Staging is private; failed/parallel installs cannot expose a half-written binary.
 */
export class DesktopWindowComponent {
  private pending: Promise<string> | undefined;
  constructor(private readonly options: Options) {
    if (!isAbsolute(options.desktopRoot) || !isAbsolute(options.cacheRoot))
      throw new Error('Host component roots must be absolute');
  }
  async executable(): Promise<string> {
    const spec = await this.spec();
    return this.verifiedExecutable(spec.directory, spec.version);
  }
  prepare(): Promise<string> {
    if (this.pending) return this.pending;
    const pending = this.install();
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => undefined);
    return pending;
  }
  private async spec() {
    const manifestPath = join(this.options.desktopRoot, 'package.json');
    const lockPath = join(this.options.desktopRoot, 'package-lock.json');
    const manifestBytes = await readFile(manifestPath);
    const lockBytes = await readFile(lockPath);
    const manifest = JSON.parse(manifestBytes.toString());
    const lock = JSON.parse(lockBytes.toString());
    const version: unknown = manifest.devDependencies?.electron;
    const pinned = lock.packages?.['node_modules/electron'];
    if (
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(version) ||
      pinned?.version !== version ||
      pinned.resolved !== `https://registry.npmjs.org/electron/-/electron-${version}.tgz` ||
      typeof pinned.integrity !== 'string'
    )
      throw new Error('Host Electron dependency must match its exact registry lock');
    const digest = createHash('sha256')
      .update(manifestBytes)
      .update(lockBytes)
      .update(process.platform)
      .update(process.arch)
      .digest('hex');
    return { version, manifestPath, lockPath, directory: join(this.options.cacheRoot, digest) };
  }
  private async verifiedExecutable(directory: string, version: string): Promise<string> {
    const moduleRoot = join(directory, 'node_modules/electron');
    const installed = JSON.parse(await readFile(join(moduleRoot, 'package.json'), 'utf8'));
    if (installed.version !== version) throw new Error('Host Electron version differs from its lock');
    const entry = (await readFile(join(moduleRoot, 'path.txt'), 'utf8')).trim();
    const dist = await realpath(join(moduleRoot, 'dist'));
    const componentRoot = await realpath(directory);
    const distributionPath = relative(componentRoot, dist);
    if (distributionPath === '..' || distributionPath.startsWith(`..${sep}`) || isAbsolute(distributionPath))
      throw new Error('Host Electron distribution escapes its component');
    const executable = await realpath(resolve(dist, entry));
    const path = relative(dist, executable);
    if (
      !entry ||
      isAbsolute(entry) ||
      path === '..' ||
      path.startsWith(`..${sep}`) ||
      isAbsolute(path) ||
      !(await lstat(executable)).isFile()
    )
      throw new Error('Host Electron executable escapes its component');
    await access(executable, constants.X_OK);
    return executable;
  }
  private async install(): Promise<string> {
    const spec = await this.spec();
    try {
      return await this.verifiedExecutable(spec.directory, spec.version);
    } catch (error) {
      // Only absence starts installation; corrupt or substituted components fail closed.
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await mkdir(this.options.cacheRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(this.options.cacheRoot, '.preparing-'));
    try {
      await copyFile(spec.manifestPath, join(staging, 'package.json'));
      await copyFile(spec.lockPath, join(staging, 'package-lock.json'));
      const run = this.options.run ?? runComponentStage;
      await run('dependencies', staging);
      await run('electron', staging);
      await this.verifiedExecutable(staging, spec.version);
      try {
        await rename(staging, spec.directory);
      } catch (error) {
        if (
          !(
            error &&
            typeof error === 'object' &&
            'code' in error &&
            ['EEXIST', 'ENOTEMPTY'].includes(String(error.code))
          )
        )
          throw error;
      }
      return await this.verifiedExecutable(spec.directory, spec.version);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export function desktopComponentEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // npm rejects loading the same path for two config layers, even /dev/null.
  // Both paths are absent inside this fresh private staging directory.
  env.npm_config_userconfig = join(directory, '.npmrc-user');
  env.npm_config_globalconfig = join(directory, '.npmrc-global');
  return env;
}

async function runComponentStage(stage: 'dependencies' | 'electron', directory: string): Promise<void> {
  const env = desktopComponentEnvironment(directory);
  const child = await new NodeExternalPluginProcessAdapter().spawn({
    command: stage === 'dependencies' ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : process.execPath,
    args:
      stage === 'dependencies'
        ? [
            'ci',
            '--include=dev',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--registry=https://registry.npmjs.org',
          ]
        : [join(directory, 'node_modules/electron/install.js')],
    cwd: directory,
    env,
  });
  child.stdout.resume();
  let diagnostic = '';
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Desktop component preparation timed out')), 180_000);
      }),
    ]);
    if (result.code !== 0) {
      const code =
        /npm (?:error|ERR!) code ([A-Z][A-Z0-9_]{0,40})\b/.exec(diagnostic)?.[1] ??
        (diagnostic.includes('double-loading config') ? 'CONFIG_LAYER_COLLISION' : 'UNCLASSIFIED');
      throw new Error(`Desktop component ${stage} failed (exit=${result.code}, signal=${result.signal}, code=${code})`);
    }
  } finally {
    clearTimeout(timer);
    await child.terminate();
  }
}
