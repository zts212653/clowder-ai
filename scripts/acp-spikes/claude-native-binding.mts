import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const pins = {
  '2.1.296': '76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a',
  '2.1.299': '295b49ec092f31a7de9c6ff286d9d8f120a4f029b9ad9a5ac0b12c35cbf4df2b',
};

export function nativeBinding(version = '2.1.296'): { version: string; sha256: string } {
  if (!Object.hasOwn(pins, version)) throw new Error('Unsupported pinned native version');
  return { version, sha256: pins[version as keyof typeof pins] };
}

export async function checkNativeHash(path: string, binding: { sha256: string }): Promise<void> {
  const actual = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  if (actual !== binding.sha256) throw new Error('Native binary pin mismatch');
}
