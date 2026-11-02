import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLICATION_POLICY_PATH = 'scripts/publication-branches.json';
export const PUBLICATION_EXECUTOR_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function parsePublicationBranches(text) {
  const value = JSON.parse(text);
  if (
    !value ||
    value.version !== 1 ||
    !['main', 'next'].includes(value.integrationBranch) ||
    value.releaseBranch !== 'main' ||
    Object.keys(value).sort().join(',') !== 'integrationBranch,releaseBranch,version'
  )
    throw new Error('invalid publication branch policy');
  return value;
}

export function readPublicationBranches(root = PUBLICATION_EXECUTOR_ROOT) {
  return parsePublicationBranches(readFileSync(join(root, PUBLICATION_POLICY_PATH), 'utf8'));
}

export function assertPublicationBranchesMatch(expected, actual, context) {
  if (expected.integrationBranch !== actual.integrationBranch || expected.releaseBranch !== actual.releaseBranch) {
    throw new Error(`publication branch policy mismatch: ${context}`);
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [root, role] = process.argv.slice(2);
    if (!root || !['integrationBranch', 'releaseBranch'].includes(role)) {
      throw new Error('usage: publication-branches.mjs <repository-root> <integrationBranch|releaseBranch>');
    }
    console.log(readPublicationBranches(root)[role]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
