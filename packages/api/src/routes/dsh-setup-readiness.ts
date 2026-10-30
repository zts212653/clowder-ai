import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { dshProviderCredentialReferences, inspectDshConfig } from './dsh-setup-config.js';
import { assertDefaultDshCredentialStore } from './dsh-setup-credential-store.js';

function read(path: string): string {
  try {
    if (statSync(path).size > 4_000_000) throw Error('dsh_config_invalid');
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw Error('dsh_setup_credential_unavailable');
  }
}
function jsonPayload(node: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (node === null) return true;
  if (isScalar(node))
    return (
      node.value === null ||
      typeof node.value === 'string' ||
      typeof node.value === 'boolean' ||
      (typeof node.value === 'number' && Number.isFinite(node.value))
    );
  if (isSeq(node)) return node.items.every((item) => jsonPayload(item, depth + 1));
  if (isMap(node))
    return node.items.every(
      ({ key, value }) => isScalar(key) && typeof key.value === 'string' && jsonPayload(value, depth + 1),
    );
  return false;
}
/** Admit only the native document's tagged-record shape; grants stay opaque,
 * never a claim of OAuth readiness. Unknown/invalid records can prevent boot. */
function validStringMap(node: unknown): boolean {
  return (
    isMap(node) &&
    node.items.every(
      ({ key, value }) =>
        isScalar(key) &&
        typeof key.value === 'string' &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key.value) &&
        isScalar(value) &&
        typeof value.value === 'string' &&
        value.value.length > 0,
    )
  );
}
function validRecord(node: unknown): boolean {
  if (!isMap(node)) return false;
  const kind: unknown = node.get('kind');
  const fields = kind === 'api-key' ? ['kind', 'key', 'env'] : kind === 'grant' ? ['kind', 'payload'] : [];
  if (
    !fields.length ||
    node.items.some(({ key }) => !isScalar(key) || typeof key.value !== 'string' || !fields.includes(key.value))
  )
    return false;
  if (kind === 'grant') return node.has('payload') && jsonPayload(node.get('payload', true));
  const apiKey: unknown = node.get('key');
  if (node.has('key') && (typeof apiKey !== 'string' || !apiKey.length)) return false;
  return !node.has('env') || validStringMap(node.get('env', true));
}
function validateRecords(records: unknown): void {
  if (records === undefined || (isScalar(records) && records.value === null)) return;
  if (
    !isMap(records) ||
    !records.items.every(
      ({ key, value }) =>
        isScalar(key) &&
        typeof key.value === 'string' &&
        /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(key.value) &&
        validRecord(value),
    )
  )
    throw Error('dsh_setup_credential_unavailable');
}
/** Inspect presence only; never copy credentials into a patch, response, or child environment. */
export function inspectDshRouteReadiness(source: string, home: string, cwd: string, env = process.env) {
  assertDefaultDshCredentialStore(source, home, cwd);
  const credentialSource = read(join(home, '.credentials.yaml'));
  const document = parseDocument(credentialSource, { uniqueKeys: true });
  if (document.errors.length) throw Error('dsh_setup_credential_unavailable');
  const root = document.contents;
  if (root !== null && !isMap(root)) throw Error('dsh_setup_credential_unavailable');
  // Native pre-release migration recognizes a plain flat mapping only. A
  // directive-bearing legacy file cannot boot and is never migrated here.
  if (
    isMap(root) &&
    !root.has('version') &&
    root.items.length &&
    credentialSource.split('\n').some((line) => /^(%|---|\.\.\.)/.test(line))
  )
    throw Error('dsh_setup_credential_unavailable');
  const version: unknown = isMap(root) ? root.get('version') : undefined;
  if (isMap(root) && root.has('version') && version !== 1) throw Error('dsh_setup_credential_unavailable');
  if (
    isMap(root) &&
    root.has('version') &&
    root.items.some(
      ({ key }) =>
        !isScalar(key) || typeof key.value !== 'string' || !['version', 'refs', 'records'].includes(key.value),
    )
  )
    throw Error('dsh_setup_credential_unavailable');
  const refs = isMap(root) ? (root.has('version') ? root.get('refs', true) : root) : undefined;
  if (refs !== undefined && !(isScalar(refs) && refs.value === null) && !isMap(refs))
    throw Error('dsh_setup_credential_unavailable');
  if (isMap(refs))
    for (const { key, value } of refs.items) {
      if (
        !isScalar(key) ||
        typeof key.value !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.value) ||
        !isScalar(value) ||
        typeof value.value !== 'string' ||
        value.value.length === 0
      )
        throw Error('dsh_setup_credential_unavailable');
    }
  const records = isMap(root) ? root.get('records', true) : undefined;
  validateRecords(records);
  const fold = (name: string) => (process.platform === 'win32' ? name.toUpperCase() : name);
  const layer = (value: NodeJS.ProcessEnv) =>
    Object.fromEntries(Object.entries(value).map(([key, item]) => [fold(key), item]));
  const inherited = layer(env);
  const dotenv = { ...layer(parseEnv(read(join(home, '.env')))), ...layer(parseEnv(read(join(cwd, '.env')))) };
  const usableKey = (value: unknown) => typeof value === 'string' && /^[\x21-\x7E]+$/.test(value.trim());
  const present = (name: string) => {
    const value = isMap(refs) ? refs.get(name, true) : undefined;
    const environment = inherited[fold(name)];
    // DSH skips empty inherited values, but a nonempty invalid value shadows
    // the saved key. A project dotenv's empty value also masks the HOME layer.
    const selected =
      environment !== undefined && environment.length > 0
        ? environment
        : isScalar(value)
          ? value.value
          : dotenv[fold(name)];
    return usableKey(selected);
  };
  const references = dshProviderCredentialReferences(source);
  return {
    ...inspectDshConfig(source),
    providers: inspectDshConfig(source).providers.map((provider) => {
      const reference = references[provider.id];
      const record = isMap(records) ? records.get(`llm-pi-ai/${provider.id}`, true) : undefined;
      const key = isMap(record) && record.get('kind') === 'api-key' ? record.get('key') : undefined;
      const ambient = (
        {
          deepseek: 'DEEPSEEK_API_KEY',
          'deepseek-official': 'DEEPSEEK_API_KEY',
          openai: 'OPENAI_API_KEY',
          anthropic: 'ANTHROPIC_API_KEY',
        } as Record<string, string>
      )[provider.id];
      const configured =
        reference !== undefined
          ? present(reference)
          : record !== undefined
            ? usableKey(key)
            : Boolean(ambient && present(ambient));
      return { ...provider, credentialStatus: configured ? ('configured' as const) : ('missing' as const) };
    }),
  };
}
