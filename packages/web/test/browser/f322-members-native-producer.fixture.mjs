// Reuse the original cats producer against a disposable catalog, never the runtime or provider.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import '../../../api/test/helpers/setup-cat-registry.js';
import { selectFakeCodexHome } from '../../../api/test/helpers/fake-codex-home.js';

const requireApi = createRequire(new URL('../../../api/package.json', import.meta.url));
const Fastify = requireApi('fastify');
const { catsRoutes } = await import('../../../api/dist/routes/cats.js');
const { _resetCachedConfig, loadCatConfig, toAllCatConfigs } = await import(
  '../../../api/dist/config/cat-config-loader.js'
);
const profile = { model: 'gemini-3.8-flash-high' };
const headers = { 'x-cat-cafe-user': 'default-user' };
export async function nativeMemberProducer(
  initialProfile,
  { cliCommand = 'agy', clientId = 'google', accountRef = 'gemini', initialModel } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'f322-member-native-'));
  const keys = [
    'CAT_TEMPLATE_PATH',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CAT_CAFE_CONFIG_ROOT',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
  ];
  const saved = keys.map((key) => process.env[key]);
  process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  selectFakeCodexHome(root);
  const template = {
    version: 2,
    breeds: [
      {
        id: 'siamese',
        catId: 'gemini38',
        name: 'Gemini',
        displayName: '烁烁',
        avatar: '/avatars/default.png',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@gemini38'],
        roleDescription: 'test',
        defaultVariantId: 'gemini38-default',
        variants: [
          {
            id: 'gemini38-default',
            clientId,
            accountRef,
            defaultModel: initialModel ?? (initialProfile ? profile.model : 'Gemini 3.8 Flash (High)'),
            mcpSupport: true,
            cli: { command: cliCommand, outputFormat: 'plainText' },
            ...(initialProfile ? { agyProfile: initialProfile } : {}),
          },
        ],
      },
    ],
    roster: { gemini38: { family: 'siamese', roles: ['assistant'], lead: false, available: true, evaluation: 'test' } },
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
    coCreator: { name: 'Owner', aliases: ['Owner'], mentionPatterns: ['@owner'] },
  };
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(process.env.CAT_TEMPLATE_PATH, JSON.stringify(template));
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(template));
  _resetCachedConfig();
  catRegistry.reset();
  for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig(process.env.CAT_TEMPLATE_PATH))))
    catRegistry.register(id, config);
  const app = Fastify();
  await app.register(catsRoutes);
  return {
    app,
    root,
    persisted: () => JSON.parse(readFileSync(join(root, '.cat-cafe/cat-catalog.json'), 'utf8')).breeds[0].variants[0],
    patch: (body) => app.inject({ method: 'PATCH', url: '/api/cats/gemini38', headers, payload: body }),
    close: async () => {
      await app.close();
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      });
      _resetCachedConfig();
      catRegistry.reset();
      for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig()))) catRegistry.register(id, config);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
