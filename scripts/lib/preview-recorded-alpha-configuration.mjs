import { join, resolve } from 'node:path';
import { alphaLaunchCoordinates, parseAlphaLaunchChild, parseAlphaLaunchOptions } from './alpha-launch-contract.mjs';

/**
 * Read historical argv as configuration only. Never execute it, resolve PATH,
 * authenticate its executable, or use this reader to admit a new child/Redis command.
 */
export function recordedAlphaConfiguration(child, mainRoot) {
  let index = 0;
  if (child[0] === 'env' || child[0] === '/usr/bin/env') {
    index++;
    while (/^[A-Za-z_]\w*=/.test(child[index] ?? '')) index++;
  }
  const script = child[index];
  if (typeof script === 'string' && resolve(mainRoot, script) === join(mainRoot, 'scripts/alpha-worktree.sh')) {
    if (child[index + 1] !== 'start') throw new Error('recorded Alpha lifecycle is not a start configuration');
    const options = parseAlphaLaunchOptions(child.slice(index + 2));
    if (!options['--instance']) throw new Error('recorded direct Alpha requires its explicit isolated tuple');
    return { coordinates: alphaLaunchCoordinates(mainRoot, options), options, recordedDirect: true };
  }
  return { ...parseAlphaLaunchChild(child, mainRoot), recordedDirect: false };
}
