import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function publicTestInvariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function comparePublicTestStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parsePublicTestCliOptions(argv) {
  publicTestInvariant(Array.isArray(argv), 'public-test CLI arguments must be an array');
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split('=', 2);
    const value = inline ?? argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    if (inline === undefined) index += 1;
    options[name] = value;
  }
  return options;
}

export async function readPublicTestJson(path, label) {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function atomicPublicTestJsonWrite(path, value) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, destination);
}
