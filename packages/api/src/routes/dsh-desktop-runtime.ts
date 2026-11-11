/** Runs inside Desktop's own Electron, both for inspection and as its read-only credential plugin. */
export const DSH_DESKTOP_RUNTIME = String.raw`
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function modules(scope) {
  const load = name => import(pathToFileURL(join(scope, name, 'lib/index.js')).href);
  const [boot, local, credentials, official, protocol, pi] = await Promise.all([
    load('dsh-app-boot'), load('dsh-credentials-local'), load('dsh-credentials'), load('dsh-llm-deepseek-api-key'),
    load('dsh-llm-deepseek'), load('dsh-llm-pi-ai'),
  ]);
  return { boot, local, credentials, official, protocol, pi };
}
function read(path) {
  try {
    if (statSync(path).size > 4_000_000) throw Error('dsh_config_invalid');
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}
function environment(source, api) {
  const previous = process.env.DSH_HOME;
  try {
    // The public native loader validates dotenv names and preserves blank-value precedence.
    process.env.DSH_HOME = source.nativeHome;
    return api.boot.loadLayeredEnv('dsh', source.nativeCwd, () => {});
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}
function document(path, api) {
  let mode;
  try { mode = statSync(path).mode; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (process.platform !== 'win32' && mode !== undefined && (mode & 0o077))
    throw Error('dsh_setup_credential_invalid');
  const text = read(path);
  try {
    // Older flat documents are normalized in memory; the user's file is never migrated.
    return api.local.parseCredentialsDocument(api.local.renderFlatLayoutMigration(text) ?? text, path);
  } catch {
    throw Error('dsh_setup_credential_invalid');
  }
}
function resolveReference(ref, store, snapshot) {
  const value = store.refs.get(ref);
  if (value !== undefined) return { value, source: 'file' };
  const inherited = snapshot.getFrom(ref, ['process']);
  if (inherited !== undefined && inherited.value.length > 0) return { value: inherited.value, source: 'env' };
  const fallback = snapshot.getFrom(ref, ['project-env', 'user-env']);
  return fallback !== undefined && fallback.value.length > 0 ? fallback : undefined;
}
function plain(value) {
  if (Array.isArray(value)) return value.every(plain);
  return value === null || typeof value !== 'object' ||
    (!Object.hasOwn(value, '__jsExpr') && Object.values(value).every(plain));
}
export async function inspect(source) {
  const api = await modules(source.nativeScope);
  const snapshot = environment(source, api);
  const directory = join(source.nativeHome, 'profiles/desktop');
  const manifestPath = join(directory, 'package.json');
  const manifest = JSON.parse(read(manifestPath));
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.length || !bundles.every(name => typeof name === 'string'))
    throw Error('dsh_setup_profile_required');
  const files = [manifestPath];
  const exemptions = api.boot.readProfileVersionExemptions(directory);
  const layers = bundles.flatMap(name => {
    const root = api.boot.resolveBundleDir('dsh', name, join(source.nativeScope, 'dsh/package.json'), directory);
    const packagePath = join(root, 'package.json');
    const pkg = JSON.parse(read(packagePath));
    const issue = api.boot.evaluatePluginCompatibility(pkg, exemptions);
    if (issue !== undefined && !issue.exempted) return [];
    const paths = api.boot.bundlePatchPaths(root, pkg.dsh.bundle);
    files.push(packagePath, ...paths);
    return [paths.flatMap(path => api.boot.loadOverlayPatches('dsh', path))];
  });
  for (const path of [join(directory, 'cordis.patch.yml'), join(source.nativeHome, 'cordis.patch.yml')]) {
    files.push(path);
    layers.push(api.boot.loadOptionalPatches('dsh', path) ?? []);
  }
  const rows = api.boot.composeEntries(layers, () => { throw Error('dsh_config_complex_patch'); });
  const config = id => {
    const matches = rows.filter(row => row.id === id);
    if (matches.length > 1) throw Error('dsh_config_ambiguous');
    if (matches[0]?.disabled !== undefined && typeof matches[0].disabled !== 'boolean') throw Error('dsh_config_expression');
    if (!matches.length || matches[0].disabled === true) return undefined;
    const expected = { credentials: 'dsh-credentials-local', 'llm-deepseek': 'dsh-llm-deepseek-api-key', 'llm-pi-ai': 'dsh-llm-pi-ai' }[id];
    if (expected && matches[0].name !== '@deepseek-ai/' + expected) throw Error('dsh_config_manual');
    const value = matches[0].config ?? {};
    if (!plain(value)) throw Error('dsh_config_expression');
    return value;
  };
  const credentialConfig = config('credentials');
  if (credentialConfig === undefined) throw Error('dsh_setup_credential_invalid');
  const credentialPath = api.local.resolveSpec({ ...credentialConfig, dshHome: credentialConfig.dshHome ?? source.nativeHome }).filename;
  const store = document(credentialPath, api);
  const configured = ref => resolveReference(ref, store, snapshot) !== undefined;
  const officialConfig = config('llm-deepseek');
  const llm = config('llm-pi-ai') ?? {};
  const selected = config('agent-default-model') ?? {};
  const inject = (id, declared) => {
    const extra = rows.find(row => row.id === id)?.inject ?? [];
    if (!Array.isArray(extra) || !extra.every(name => typeof name === 'string')) throw Error('dsh_config_manual');
    return [...new Set([...declared, ...extra, 'credentials'])];
  };
  const providers = [];
  if (officialConfig !== undefined) {
    const connection = api.official.resolveAdapterOptions(officialConfig, snapshot);
    providers.push({
      id: 'deepseek-official', credential: configured(connection.apiKeyEnv) ? 'configured' : 'missing',
      models: connection.models.map(model => ({ id: model.id, label: model.name ?? model.id })),
    });
  }
  for (const [id, value] of Object.entries(llm.providers ?? {})) {
    if (id === 'deepseek-official') throw Error('dsh_config_ambiguous');
    providers.push({ id,
      credential: value.apiKeyEnv === undefined
        ? store.records.has('llm-pi-ai/' + id) ? 'configured' : 'native_auth'
        : configured(api.credentials.credentialRef(value.apiKeyEnv)) ? 'configured' : 'missing',
      models: (value.models ?? []).map(model => ({ id: model.id, label: model.name ?? model.id })),
    });
  }
  const available = providers.filter(route => route.credential !== 'missing' && route.models.length);
  const route = available.find(route => route.id === 'deepseek-official') ??
    available.find(route => route.id === selected.provider) ?? (available.length === 1 ? available[0] : undefined);
  files.push(credentialPath, join(source.nativeCwd, '.env'), join(source.nativeHome, '.env'));
  const revision = createHash('sha256').update(JSON.stringify(files.map(path => [path, read(path)]))).digest('hex');
  return { source, credentialPath, officialConfig, llm, providers, revision,
    officialFields: [...Object.keys(api.protocol.deepSeekConfigFields), ...Object.keys(api.protocol.modelListingConfigFields), 'apiKeyEnv'],
    officialInject: inject('llm-deepseek', api.official.inject),
    customInject: inject('llm-pi-ai', api.pi.inject),
    provider: route?.id,
    model: route?.models.find(model => model.id === selected.model)?.id ?? route?.models[0]?.id,
  };
}

export async function apply(ctx, config) {
  const api = await modules(config.nativeScope);
  const snapshot = environment(config, api);
  ctx.root.set('launchEnvironment', snapshot);
  class ReadOnlyCredentials extends api.credentials.CredentialProvider {
    async resolve(ref) { return resolveReference(ref, document(config.credentialPath, api), snapshot); }
    async describe(ref) {
      const hit = await this.resolve(ref);
      return { configured: hit !== undefined, ...(hit ? { source: hit.source } : {}), writable: false };
    }
    async readRecord(key) { return document(config.credentialPath, api).records.get(key); }
    async describeRecord(key) {
      const hit = await this.readRecord(key);
      return { configured: hit !== undefined, ...(hit ? { kind: hit.kind } : {}), writable: false };
    }
    async listRecords() {
      return [...document(config.credentialPath, api).records].map(([key, value]) => ({
        key: api.credentials.parseCredentialKey(key), kind: value.kind,
      }));
    }
    async set() { throw Error('dsh_desktop_auth_read_only'); }
    async unset() { throw Error('dsh_desktop_auth_read_only'); }
    // Refuse before calling a refresh/mutation callback: no HTTP followed by a discarded write.
    async modifyRecord() { throw Error('dsh_desktop_auth_read_only'); }
    async deleteRecord() { throw Error('dsh_desktop_auth_read_only'); }
  }
  new ReadOnlyCredentials(ctx);
}

if (process.argv[2] === 'inspect') {
  inspect(JSON.parse(process.argv[3])).then(
    value => process.stdout.write(JSON.stringify(value)),
    error => process.stdout.write(JSON.stringify({
      error: /^dsh_[a-z_]+$/.test(error.message) ? error.message : 'dsh_setup_unavailable',
    })),
  );
}
`;
