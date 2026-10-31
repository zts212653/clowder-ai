import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

async function command(file, args, options, errorMessage) {
  try {
    return await execFileAsync(file, args, { maxBuffer: 10 * 1024 * 1024, ...options });
  } catch (error) {
    const output = [error.stderr, error.stdout]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .trim()
      .split('\n')
      .slice(-8)
      .join('\n');
    throw new Error(output.length > 0 ? `${errorMessage}: ${output}` : errorMessage, { cause: error });
  }
}

async function listFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
    else throw new Error(`artifact tree contains unsupported entry ${relative(root, path)}`);
  }
  return files.sort();
}

async function digestFiles(root, paths) {
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    hash.update(await readFile(join(root, path)));
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
}

async function packageReleaseFiles(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.some((path) => typeof path !== 'string')) {
    throw new Error(`package ${manifest.name} must declare a literal files array for artifact provenance`);
  }
  const files = ['package.json'];
  for (const declaredPath of manifest.files) {
    if (declaredPath.length === 0 || isAbsolute(declaredPath) || declaredPath.split(/[\\/]+/).includes('..')) {
      throw new Error(`package ${manifest.name} declares unsafe release path ${declaredPath}`);
    }
    const absolutePath = resolve(root, declaredPath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
      throw new Error(`package ${manifest.name} release path escapes its package root`);
    }
    const metadata = await stat(absolutePath);
    if (metadata.isDirectory()) files.push(...(await listFiles(root, absolutePath)));
    else if (metadata.isFile()) files.push(declaredPath.split(sep).join('/'));
    else throw new Error(`package ${manifest.name} release path is not a file or directory`);
  }
  return { manifest, files: [...new Set(files)].sort() };
}

async function packageReleaseDigest(root) {
  const { files } = await packageReleaseFiles(root);
  return digestFiles(root, files);
}

async function packageRoot(specifier) {
  let directory = dirname(await realpath(fileURLToPath(import.meta.resolve(specifier))));
  for (;;) {
    const candidate = join(directory, 'package.json');
    try {
      if ((await stat(candidate)).isFile()) return directory;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`cannot locate package root for ${specifier}`);
    directory = parent;
  }
}

export async function packageEvidence(specifier, resolveSpecifier = specifier) {
  const root = await packageRoot(resolveSpecifier);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  return {
    root,
    name: manifest.name,
    version: manifest.version,
    contentDigest: await packageReleaseDigest(root),
  };
}

export function reportPackageEvidence({ name, version, contentDigest }) {
  return { name, version, contentDigest };
}

export async function gitOutput(args, cwd) {
  const { stdout } = await command('git', args, { cwd }, `git ${args.join(' ')} failed`);
  return stdout.trim();
}

async function gitEvidence(args, cwd, errorMessage, trim = true) {
  const { stdout } = await command('git', args, { cwd }, errorMessage);
  return trim ? stdout.trim() : stdout;
}

export async function gitRepository(requestedPath, argumentName) {
  const path = await realpath(resolve(requestedPath));
  const root = await realpath(await gitOutput(['rev-parse', '--show-toplevel'], path));
  if (path !== root) throw new Error(`${argumentName} must name a Git repository root`);
  return root;
}

export async function verifiedCommit(repository, argumentName, sha) {
  const errorMessage = `${argumentName} ${sha} does not resolve to a commit in the declared repository`;
  const resolved = await gitEvidence(['rev-parse', '--verify', `${sha}^{commit}`], repository, errorMessage);
  if (resolved !== sha) throw new Error(errorMessage);
}

async function commitFile(repository, sha, path) {
  return gitEvidence(
    ['show', `${sha}:${path}`],
    repository,
    `commit ${sha} does not contain required provenance file ${path}`,
    false,
  );
}

export async function verifyHostProvenance({
  repository,
  executedSha,
  acceptanceReviewedSha,
  frozenReviewedSha,
  mergeSha,
}) {
  await Promise.all([
    verifiedCommit(repository, '--host-acceptance-reviewed-sha', acceptanceReviewedSha),
    verifiedCommit(repository, '--host-reviewed-sha', frozenReviewedSha),
    verifiedCommit(repository, '--host-merge-sha', mergeSha),
  ]);
  if (acceptanceReviewedSha !== executedSha) {
    throw new Error(
      `acceptance-reviewed Host commit ${acceptanceReviewedSha} does not match executed HEAD ${executedSha}`,
    );
  }
  if (frozenReviewedSha === mergeSha) {
    throw new Error('reviewed Host commit and merged Host commit must be distinct coordinates');
  }
  if (mergeSha === executedSha) {
    throw new Error('merged Host predecessor must be a strict ancestor of the executed acceptance HEAD');
  }
  await gitEvidence(
    ['merge-base', '--is-ancestor', mergeSha, executedSha],
    repository,
    `merged Host commit ${mergeSha} is not an ancestor of executed HEAD ${executedSha}`,
  );
  const [reviewedTree, mergeTree, executionTree] = await Promise.all([
    gitOutput(['rev-parse', `${frozenReviewedSha}^{tree}`], repository),
    gitOutput(['rev-parse', `${mergeSha}^{tree}`], repository),
    gitOutput(['rev-parse', `${executedSha}^{tree}`], repository),
  ]);
  if (reviewedTree !== mergeTree) {
    throw new Error(`reviewed Host commit ${frozenReviewedSha} and merge commit ${mergeSha} do not have the same tree`);
  }
  return {
    executionMatchesAcceptanceReview: true,
    mergeIsStrictAncestorOfExecution: true,
    frozenReviewedTreeMatchesMerge: true,
    frozenTreeSha: reviewedTree,
    executionTreeSha: executionTree,
  };
}

async function buildPluginArtifacts(repository, sha) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'm0d-plugin-artifacts-'));
  const checkoutRoot = join(temporaryRoot, 'checkout');
  const archivePath = join(temporaryRoot, 'source.tar');
  await mkdir(checkoutRoot);
  try {
    await command(
      'git',
      ['archive', '--format=tar', `--output=${archivePath}`, sha],
      { cwd: repository },
      `cannot derive loaded plugin artifacts from commit ${sha}`,
    );
    await command(
      'tar',
      ['-xf', archivePath, '-C', checkoutRoot],
      {},
      `cannot derive loaded plugin artifacts from commit ${sha}`,
    );
    const buildEnvironment = { ...process.env, NODE_ENV: 'development' };
    await command(
      pnpmCommand,
      ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--prod=false'],
      { cwd: checkoutRoot, env: buildEnvironment },
      `cannot derive loaded plugin artifacts from commit ${sha}`,
    );
    for (const packageName of ['plugin-contract', 'plugin-sdk']) {
      await command(
        pnpmCommand,
        ['exec', 'tsc', '-p', `packages/${packageName}/tsconfig.build.json`],
        { cwd: checkoutRoot, env: buildEnvironment },
        `cannot derive loaded plugin artifacts from commit ${sha}`,
      );
    }
    return {
      contract: await packageReleaseDigest(join(checkoutRoot, 'packages/plugin-contract')),
      sdk: await packageReleaseDigest(join(checkoutRoot, 'packages/plugin-sdk')),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function verifyPluginsProvenance({ repository, sha, contract, sdk, fixtureBytes }) {
  const contractManifestPath = 'packages/plugin-contract/package.json';
  const sdkManifestPath = 'packages/plugin-sdk/package.json';
  const fixturePath = 'packages/plugin-contract/fixtures/behavior/messaging/adversarial-invariants.json';
  const [contractManifestBytes, sdkManifestBytes, sourceFixtureBytes] = await Promise.all([
    commitFile(repository, sha, contractManifestPath),
    commitFile(repository, sha, sdkManifestPath),
    commitFile(repository, sha, fixturePath),
  ]);
  const sourceContract = JSON.parse(contractManifestBytes);
  const sourceSdk = JSON.parse(sdkManifestBytes);
  if (sourceContract.name !== contract.name || sourceContract.version !== contract.version) {
    throw new Error(
      `plugin source ${sha} declares ${sourceContract.name}@${sourceContract.version}, not loaded ${contract.name}@${contract.version}`,
    );
  }
  if (sourceSdk.name !== sdk.name || sourceSdk.version !== sdk.version) {
    throw new Error(
      `plugin source ${sha} declares ${sourceSdk.name}@${sourceSdk.version}, not loaded ${sdk.name}@${sdk.version}`,
    );
  }
  if (!Buffer.from(sourceFixtureBytes).equals(fixtureBytes)) {
    throw new Error(`plugin source ${sha} behavior fixture does not match the loaded package bytes`);
  }
  const built = await buildPluginArtifacts(repository, sha);
  for (const [label, loaded] of [
    ['contract', contract],
    ['sdk', sdk],
  ]) {
    if (built[label] !== loaded.contentDigest) {
      throw new Error(
        `loaded ${loaded.name} artifact ${loaded.contentDigest} does not match build ${built[label]} derived from plugin source ${sha}`,
      );
    }
  }
  return {
    commitVerified: true,
    packageVersionsMatch: true,
    behaviorFixtureBytesMatch: true,
    loadedArtifactsMatchSourceBuild: true,
    artifactDigests: built,
  };
}

export async function rebuildHostRuntime(repository) {
  await command(
    pnpmCommand,
    ['--dir', 'packages/api', 'build'],
    { cwd: repository },
    'cannot rebuild Host runtime from the executed tree',
  );
  const runtimeRoot = join(repository, 'packages/api/dist');
  return {
    rebuiltFromExecutedTree: true,
    contentDigest: await digestFiles(runtimeRoot, await listFiles(runtimeRoot)),
  };
}
