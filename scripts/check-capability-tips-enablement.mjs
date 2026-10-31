import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const DOMAIN_REF = 'docs/harness-feedback/eval-domains/eval-capability-tips.yaml';
const GATE_REF = 'docs/harness-feedback/registry/eval-capability-tips-enable-gate.yaml';

export async function checkCapabilityTipsEnablementForRepo(repoRoot, options = {}) {
  const apiDistRoot = options.apiDistRoot ?? resolve(repoRoot, 'packages/api/dist');
  try {
    const [{ parseEvalDomainRegistryFile }, { validateCapabilityTipsEnablement }] = await Promise.all([
      import(pathToFileURL(resolve(apiDistRoot, 'infrastructure/harness-eval/domain/eval-domain-registry.js')).href),
      import(
        pathToFileURL(
          resolve(apiDistRoot, 'infrastructure/harness-eval/capability-tips/capability-tips-enable-gate.js'),
        ).href
      ),
    ]);
    const domain = parseEvalDomainRegistryFile(readYaml(resolve(repoRoot, DOMAIN_REF)));
    const evidence = readYaml(resolve(repoRoot, GATE_REF));
    const error = validateCapabilityTipsEnablement(domain, evidence, (ref) => {
      const artifactPath = resolve(repoRoot, ref);
      const repoRelative = relative(repoRoot, artifactPath);
      if (repoRelative.startsWith('..') || isAbsolute(repoRelative) || !existsSync(artifactPath)) return undefined;
      return readYaml(artifactPath);
    });

    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readYaml(path) {
  return parse(readFileSync(path, 'utf8'));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const repoRoot = resolve(import.meta.dirname, '..');
  const result = await checkCapabilityTipsEnablementForRepo(repoRoot);
  if (!result.ok) {
    console.error(`[capability-tips-enablement] ERROR: ${result.error}`);
    process.exitCode = 1;
  } else {
    console.log('[capability-tips-enablement] OK');
  }
}
