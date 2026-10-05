// This executable attaches to a single Host-owned surface via private pipes.
// It deliberately imports no ServiceManager and starts no API/Redis process.
const electron = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createManagedWindow } = require('./window.cjs');
const { createCompanionPipe } = require('./companion-pipe.cjs');
const { prepareWindowResources } = require('./preload-bundle.cjs');
const { configureCompanionAppIdentity } = require('./app-identity.cjs');
const { app } = electron;
const stage = (value) => process.stderr.write(`[desktop-stage] ${value}\n`);
stage('kernel-started');
const contract = import(
  pathToFileURL(join(__dirname, '../../packages/api/dist/domains/plugin/desktop-window-runtime/admission.js')).href
).then(
  (module) => module,
  () => null,
);
const profile = mkdtempSync(join(tmpdir(), 'clowder-companion-'));
const identityReady = configureCompanionAppIdentity(app);
app.setPath('userData', profile);
process.once('exit', () => rmSync(profile, { recursive: true, force: true }));
let window;
let opening = false;
let ended = false;
let buffer = Buffer.alloc(0);
let queue = Promise.resolve();
const companion = createCompanionPipe((frame, callback) => process.stdout.write(frame, callback));
const quit = () => {
  if (ended) return;
  ended = true;
  companion.close();
  window?.close();
  app.quit();
};
function fatal() {
  if (ended) return;
  ended = true;
  process.stderr.write('[desktop-executor] invalid_or_unavailable_window\n');
  companion.close();
  window?.close();
  app.exit(1);
}
async function handle(message) {
  if (
    ended ||
    !message ||
    Object.keys(message).sort().join(',') !== 'id,method,params,v' ||
    message.v !== 1 ||
    !Number.isSafeInteger(message.id) ||
    message.id < 1
  )
    throw new Error('Protocol');
  let value = null;
  if (message.method === 'open') {
    if (opening) throw new Error('Already opened');
    opening = true;
    await app.whenReady();
    await identityReady;
    stage('app-ready');
    const loadedContract = await contract;
    if (!loadedContract) throw new Error('Contract unavailable');
    const validateCompanionCommand = loadedContract.companionCommandValidator(message.params.companionContract);
    stage('contract-ready');
    window = await createManagedWindow(electron, message.params, {
      voiceResources: prepareWindowResources(profile),
      onFailure: (reason) => process.stderr.write(`[desktop-runtime] ${reason}\n`),
      request: async (command) => {
        stage('bridge-requested');
        const reply = await companion.request(command);
        stage('bridge-replied');
        return reply;
      },
      validate: validateCompanionCommand,
    });
    stage('surface-loaded');
  } else {
    if (
      !window ||
      !['poll', 'show', 'close', 'navigate', 'revoke-media'].includes(message.method) ||
      (message.method !== 'navigate' && message.params !== null)
    )
      throw new Error('Protocol');
    if (message.method === 'poll') value = window.poll();
    if (message.method === 'show') window.show();
    if (message.method === 'revoke-media') await window.revokeMedia();
    if (message.method === 'navigate') await window.navigate(message.params);
  }
  await new Promise((resolve, reject) =>
    process.stdout.write(`${JSON.stringify({ v: 1, id: message.id, ok: true, value })}\n`, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  if (message.method === 'close') quit();
}
process.stdin.on('data', (chunk) => {
  if (ended) return;
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length) {
    const newline = buffer.indexOf(10);
    if ((newline < 0 && buffer.length > 1_600_000) || newline > 1_600_000) {
      fatal();
      return;
    }
    if (newline < 0) return;
    const line = buffer.subarray(0, newline);
    buffer = buffer.subarray(newline + 1);
    try {
      const message = JSON.parse(line.toString('utf8'));
      if (message.type === 'companion') {
        companion.accept(message);
        continue;
      }
      if (line.length > 8192) throw new Error('Oversized control frame');
      queue = queue.then(() => handle(message)).catch(fatal);
    } catch {
      fatal();
      return;
    }
  }
});
process.stdin.on('end', quit);
process.on('SIGTERM', quit);
app.on('window-all-closed', quit);
