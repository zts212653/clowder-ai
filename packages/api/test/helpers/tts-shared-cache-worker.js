import { ListenAssetService } from '../../dist/domains/cats/services/tts/ListenAssetService.js';
import { MlxAudioTtsProvider } from '../../dist/domains/cats/services/tts/MlxAudioTtsProvider.js';
import { TtsRegistry } from '../../dist/domains/cats/services/tts/TtsRegistry.js';

const [cacheDir, baseUrl] = process.argv.slice(2);
const fetch = globalThis.fetch;
let active;
globalThis.fetch = async (url, init) => {
  const health = String(url).endsWith('/health');
  if (active.id === 'late-send' && !active.held && health) {
    active.held = true;
    await fetch(`${baseUrl}/before-health`);
  }
  try {
    const response = await fetch(url, { ...init, headers: { ...init?.headers, 'x-tts-test-worker': active.id } });
    if (health && response.ok) active.healthSuccesses++;
    return response;
  } catch (error) {
    if (health) active.healthFailures++;
    throw error;
  }
};
async function runRequest({ id, model }) {
  active = { id, held: false, healthSuccesses: 0, healthFailures: 0 };
  const registry = new TtsRegistry();
  registry.register(new MlxAudioTtsProvider({ baseUrl, ...(model === 'auto' ? {} : { model }) }));
  const assets = new ListenAssetService(registry, cacheDir);
  let result;
  let error;
  try {
    result = await assets.getOrCreate('共享缓存策略测试。');
  } catch (cause) {
    error = cause.message;
  } finally {
    await assets.close();
  }
  process.send({ result, error, healthSuccesses: active.healthSuccesses, healthFailures: active.healthFailures });
}
let pendingRun = Promise.resolve();
process.on('message', (message) => {
  if (message.close) {
    void pendingRun.finally(() => process.disconnect());
    return;
  }
  pendingRun = runRequest(message);
});
process.send({ ready: true });
