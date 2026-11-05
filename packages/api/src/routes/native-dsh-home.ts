import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Match DSH's blank-as-unset rule without resolving unsupported relative roots
 * against a different Host/bootstrap cwd. Nonblank paths retain their bytes. */
export function resolveDshHome(configured = process.env.DSH_HOME): string {
  const home = configured === undefined || configured.trim() === '' ? join(homedir(), '.dsh') : configured;
  if (!isAbsolute(home)) throw Error('dsh_setup_custom_startup');
  return resolve(home);
}
