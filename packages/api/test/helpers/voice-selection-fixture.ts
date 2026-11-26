import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry, type TtsSynthesizeRequest } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { loadCatConfig, toAllCatConfigs } from '../../src/config/cat-config-loader.js';
import { clearVoiceCache } from '../../src/config/cat-voices.js';
import { TtsRegistry } from '../../src/domains/cats/services/tts/TtsRegistry.js';
import { ttsRoutes } from '../../src/routes/tts.js';

const roots: string[] = [];
const savedTemplate = process.env.CAT_TEMPLATE_PATH;
const savedVoiceDir = process.env.CHARACTER_VOICE_DIR;
const savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
afterEach(async () => {
  if (savedTemplate === undefined) delete process.env.CAT_TEMPLATE_PATH;
  else process.env.CAT_TEMPLATE_PATH = savedTemplate;
  if (savedVoiceDir === undefined) delete process.env.CHARACTER_VOICE_DIR;
  else process.env.CHARACTER_VOICE_DIR = savedVoiceDir;
  if (savedConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
  else process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
  clearVoiceCache();
  catRegistry.reset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export async function fixture(referenceAudioSupport?: boolean, voiceIdSupport?: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'tts-voice-selection-'));
  roots.push(root);
  const templatePath = join(root, 'cat-template.json');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const template = JSON.parse(await readFile(join(repo, 'cat-template.json'), 'utf8'));
  template.breeds.push({
    ...template.breeds[0],
    id: 'new-member',
    catId: 'new-member',
    mentionPatterns: ['@new-member'],
    defaultVariantId: 'new-member-default',
    variants: [
      { ...template.breeds[0].variants[0], id: 'new-member-default', catId: 'new-member', voiceConfig: undefined },
    ],
  });
  template.breeds[0].variants.push({
    ...template.breeds[0].variants[0],
    id: 'inherited-voice',
    catId: 'inherited-voice',
    voiceConfig: undefined,
  });
  await writeFile(templatePath, JSON.stringify(template));
  process.env.CAT_TEMPLATE_PATH = templatePath;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  process.env.CHARACTER_VOICE_DIR = root;
  const reference = join(root, template.breeds[0].variants[0].voiceConfig.refAudio);
  await mkdir(dirname(reference), { recursive: true });
  await writeFile(reference, 'reference-audio-fixture');
  clearVoiceCache();
  catRegistry.reset();
  for (const config of Object.values(toAllCatConfigs(loadCatConfig()))) catRegistry.register(config.id, config);
  const requests: TtsSynthesizeRequest[] = [];
  const registry = new TtsRegistry();
  registry.register({
    id: 'fixture',
    model: 'fixture-model',
    referenceAudioSupport,
    referenceAudioContentSupport: referenceAudioSupport === true,
    voiceIdSupport,
    synthesize: async (request: TtsSynthesizeRequest) => {
      let referenceAudio: import('@cat-cafe/shared').TtsSynthesizeResult['referenceAudio'];
      let effective = request;
      if (request.refAudio) {
        try {
          const content = request.refAudioData
            ? Buffer.from(request.refAudioData.base64, 'base64')
            : await readFile(request.refAudio);
          if (!content.length) throw new Error('Reference audio unavailable');
          referenceAudio = { status: 'used', sha256: createHash('sha256').update(content).digest('hex') };
        } catch {
          referenceAudio = { status: 'unavailable' };
          const {
            refAudio: _source,
            refAudioData: _data,
            refText: _text,
            instruct: _instruct,
            temperature: _temperature,
            ...fallback
          } = request;
          effective = fallback;
        }
      }
      requests.push(effective);
      return {
        audio: Buffer.from('RIFF-audio-fixture'),
        format: 'wav',
        referenceAudio,
        metadata: { provider: 'fixture', model: 'fixture-model', voice: request.voice },
      };
    },
  });
  const app = Fastify();
  await app.register(ttsRoutes, { ttsRegistry: registry, cacheDir: join(root, 'cache') });
  return { app, requests, root, template, templatePath, registry };
}
