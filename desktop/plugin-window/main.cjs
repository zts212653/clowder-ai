// This executable attaches to a single Host-owned surface via private pipes.
// It deliberately imports no ServiceManager and starts no API/Redis process.
const electron = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createManagedWindow } = require('./window.cjs');
const { createCompanionPipe } = require('./companion-pipe.cjs');
const { createAppAssistOwnerPipe } = require('./app-assist-pipe.cjs');
const { createAppAssistHost } = require('./app-assist-host.cjs');
const { createNativeAppAssistSource } = require('./app-assist-source.cjs');
const { prepareWindowResources } = require('./preload-bundle.cjs');
const { configureCompanionAppIdentity } = require('./app-identity.cjs');
const { createExecutorStdio } = require('./executor-stdio.cjs');
const { app } = electron;
let window;
let opening = false;
let ended = false;
let companion;
let appAssist;
let appAssistOwner;
let appAssistClosed = Promise.resolve();
const stdio = createExecutorStdio(process.stdout, process.stderr, quit);
const stage = (value) => {
  if (!ended) stdio.diagnostic(`[desktop-stage] ${value}\n`);
};
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
let buffer = Buffer.alloc(0);
let queue = Promise.resolve();
companion = createCompanionPipe((frame, callback) => stdio.write(frame, callback));
appAssistOwner = createAppAssistOwnerPipe((frame, callback) => stdio.write(frame, callback));
function finish() {
  if (ended) return false;
  ended = true;
  stdio.close();
  companion?.close();
  appAssistOwner?.close();
  appAssistClosed = appAssist?.close() ?? Promise.resolve();
  window?.close();
  return true;
}
function quit() {
  if (finish()) void appAssistClosed.finally(() => app.quit());
}
function fatal() {
  if (!finish()) return;
  stdio.diagnostic('[desktop-executor] invalid_or_unavailable_window\n');
  void appAssistClosed.finally(() => app.exit(1));
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
    if (ended) return;
    await identityReady;
    if (ended) return;
    stage('app-ready');
    const loadedContract = await contract;
    if (ended) return;
    if (!loadedContract) throw new Error('Contract unavailable');
    const validateCompanionCommand = loadedContract.companionCommandValidator(message.params.companionContract);
    if (message.params.appAssist === true)
      appAssist = createAppAssistHost({
        owner: appAssistOwner,
        sourceFactory: createNativeAppAssistSource,
        validateReply: loadedContract.appAssistReplyValidator(message.params.companionContract),
        selfBundleIds: ['ai.clowderai.desktop', 'com.github.Electron'],
      });
    stage('contract-ready');
    const { appAssist: _appAssistCapability, ...windowInput } = message.params;
    const opened = await createManagedWindow(electron, windowInput, {
      ...(appAssist ? { appAssist } : {}),
      voiceResources: prepareWindowResources(profile),
      onFailure: (reason) => {
        if (!ended) stdio.diagnostic(`[desktop-runtime] ${reason}\n`);
      },
      request: async (command) => {
        if (ended) return { kind: 'error', code: 'cancelled' };
        stage('bridge-requested');
        const reply = await companion.request(command);
        stage('bridge-replied');
        return reply;
      },
      validate: validateCompanionCommand,
      onVoiceObservation: (value) => {
        if (!ended) stdio.write(`${JSON.stringify({ v: 1, type: 'voice_observation', value })}\n`, () => {});
      },
      onTextSubmission: (value) => {
        if (!ended) stdio.write(`${JSON.stringify({ v: 1, type: 'text_submission', value })}\n`, () => {});
      },
    });
    if (ended) {
      opened.close();
      return;
    }
    window = opened;
    stage('surface-loaded');
  } else {
    if (
      !window ||
      !['poll', 'show', 'close', 'navigate', 'revoke-media', 'app-assist-policy'].includes(message.method) ||
      (!['navigate', 'app-assist-policy'].includes(message.method) && message.params !== null)
    )
      throw new Error('Protocol');
    if (message.method === 'poll') value = window.poll();
    if (message.method === 'show') window.show();
    if (message.method === 'revoke-media') await window.revokeMedia();
    if (message.method === 'navigate') await window.navigate(message.params);
    if (message.method === 'app-assist-policy') {
      if (
        !appAssist ||
        !message.params ||
        Object.keys(message.params).join(',') !== 'allowed' ||
        ![true, false, null].includes(message.params.allowed)
      )
        throw new Error('Protocol');
      await appAssist.policyChanged(message.params.allowed);
    }
  }
  if (ended) return;
  await new Promise((resolve, reject) =>
    stdio.write(`${JSON.stringify({ v: 1, id: message.id, ok: true, value })}\n`, (error) =>
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
      if (message.type === 'app_assist') {
        appAssistOwner.accept(message);
        continue;
      }
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
process.stdin.on('error', quit);
process.on('SIGTERM', quit);
app.on('before-quit', (event) => {
  if (!finish() || !appAssist) return;
  event.preventDefault();
  void appAssistClosed.finally(() => app.quit());
});
app.on('window-all-closed', quit);
