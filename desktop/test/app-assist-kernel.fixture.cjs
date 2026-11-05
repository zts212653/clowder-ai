const { createInterface } = require('node:readline');
const { createAppAssistHost } = require('../plugin-window/app-assist-host.cjs');
const { createAppAssistOwnerPipe } = require('../plugin-window/app-assist-pipe.cjs');
const write = (line, done = () => {}) => process.stdout.write(line, done);
const owner = createAppAssistOwnerPipe(write);
const host = createAppAssistHost({
  owner,
  selfBundleIds: ['ai.fixture.self'],
  sourceFactory: async (observe) => {
    queueMicrotask(() => void observe({ bundleId: 'org.fixture.editor', name: 'Fixture Editor' }));
    return { close: async () => {} };
  },
});
let queue = Promise.resolve();
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const frame = JSON.parse(line);
    if (frame.type === 'app_assist') {
      owner.accept(frame);
      return;
    }
    queue = queue
      .then(async () => {
        let value = null;
        if (frame.method === 'open') {
          if (frame.params.appAssist !== true || frame.params.companionContract !== '0.1.0-beta.29')
            throw new Error('Invalid fixture launch');
          await host.resume();
        } else if (frame.method === 'app-assist-policy') await host.policyChanged(frame.params.allowed);
        else if (frame.method === 'poll') value = host.snapshot().offer ? 'visible' : 'hidden';
        else if (frame.method === 'close') {
          await host.close();
          owner.close();
        } else throw new Error('Unsupported fixture control');
        write(`${JSON.stringify({ v: 1, id: frame.id, ok: true, value })}\n`, () => {
          if (frame.method === 'close') process.exit(0);
        });
      })
      .catch(() => process.exit(1));
  })
  .on('close', () => {
    void host.close().finally(() => process.exit(0));
  });
