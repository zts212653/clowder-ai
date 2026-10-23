import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml';
import { pathsEqual } from '../utils/project-path.js';

const provider = '@deepseek-ai/dsh-credentials-local';
const defaultLocation = (node: unknown, expected: string, cwd: string, expandHome = false) => {
  if (
    !isScalar(node) ||
    typeof node.value !== 'string' ||
    !node.value.trim() ||
    (node.tag && node.tag !== 'tag:yaml.org,2002:str')
  )
    return false;
  const value = expandHome
    ? node.value === '~'
      ? homedir()
      : /^~[/\\]/.test(node.value)
        ? join(homedir(), node.value.slice(2))
        : node.value
    : node.value;
  return pathsEqual(resolve(cwd, value), resolve(expected));
};

/** Automatic reuse supports the shipped local resolver at the same default
 * store. Unknown/disabled/replaced resolvers and other locations remain manual;
 * never inspect arbitrary credential paths or copy resolver authority. */
export function assertDefaultDshCredentialStore(
  source: string,
  home: string,
  cwd: string,
  requireResolver = false,
): void {
  if (!home.trim() || !isAbsolute(home)) throw Error('dsh_setup_custom_startup');
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length || !isSeq(document.contents)) throw Error('dsh_config_invalid');
  const resolvers = document.contents.items.filter((row) => {
    if (!isMap(row)) return false;
    const id: unknown = row.get('id');
    const name: unknown = row.get('name');
    return (
      id === 'credentials' || id === 'credentials-local' || (typeof name === 'string' && /credentials?/i.test(name))
    );
  });
  if (resolvers.length > 1 || (requireResolver && resolvers.length !== 1)) throw Error('dsh_setup_custom_startup');
  for (const row of resolvers) {
    if (!isMap(row)) throw Error('dsh_setup_custom_startup');
    const id: unknown = row.get('id');
    if (id !== 'credentials') throw Error('dsh_setup_custom_startup');
    visit(row, (_key, node) => {
      if (isAlias(node)) throw Error('dsh_setup_custom_startup');
      if (
        (isMap(node) || isScalar(node) || isSeq(node)) &&
        node.tag &&
        !/^tag:yaml.org,2002:(?:map|seq|str|int|float|bool|null)$/.test(node.tag)
      )
        throw Error('dsh_setup_custom_startup');
    });
    if (
      row.items.some(
        ({ key }) =>
          !isScalar(key) || typeof key.value !== 'string' || !['id', 'name', 'config', 'disabled'].includes(key.value),
      )
    )
      throw Error('dsh_setup_custom_startup');
    const name: unknown = row.get('name');
    const disabled: unknown = row.get('disabled');
    if ((requireResolver || name !== undefined) && name !== provider) throw Error('dsh_setup_custom_startup');
    if (disabled !== undefined && disabled !== false) throw Error('dsh_setup_custom_startup');
    const config = row.get('config', true);
    if (config === undefined) continue;
    if (!isMap(config)) throw Error('dsh_setup_custom_startup');
    if (
      config.items.some(
        ({ key }) =>
          !isScalar(key) ||
          typeof key.value !== 'string' ||
          !['path', 'dshHome', 'watch', 'debounceMs'].includes(key.value),
      )
    )
      throw Error('dsh_setup_custom_startup');
    if (config.has('watch') && typeof config.get('watch') !== 'boolean') throw Error('dsh_setup_custom_startup');
    const debounce: unknown = config.get('debounceMs');
    if (config.has('debounceMs') && (typeof debounce !== 'number' || !Number.isFinite(debounce) || debounce < 0))
      throw Error('dsh_setup_custom_startup');
    if (config.has('path') && !defaultLocation(config.get('path', true), join(home, '.credentials.yaml'), cwd))
      throw Error('dsh_setup_custom_startup');
    if (config.has('dshHome') && !defaultLocation(config.get('dshHome', true), home, cwd, true))
      throw Error('dsh_setup_custom_startup');
  }
}
