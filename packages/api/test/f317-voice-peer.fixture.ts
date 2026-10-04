import { createServer } from 'node:http';

/** Test-only native peer: actual local WebRTC, synthetic sound, no model or hardware. */
export async function nativeVoicePeerFixture() {
  let giveOffer!: (sdp: string) => void;
  let giveAnswer!: (sdp: string) => void;
  const offer = new Promise<string>((resolve) => {
    giveOffer = resolve;
  });
  const answer = new Promise<string>((resolve) => {
    giveAnswer = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url === '/offer' && request.method === 'GET') {
      void offer.then((sdp) => response.end(JSON.stringify({ sdp })));
    } else if (request.url === '/answer' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 128000) request.destroy();
      });
      request.on('end', () => {
        giveAnswer(body);
        response.end('accepted');
      });
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  const remoteScript = `async function connect(offer) {
    const peer = globalThis.testPeer = new RTCPeerConnection();
    peer.ondatachannel = ({channel}) => {
      channel.onopen = () => channel.send(JSON.stringify({ type: 'output_transcript.added',
        item: { text: 'synthetic remote voice', id: 'test-item' }, turn_id: 'test-turn', token: 'not-public' }));
    };
    const audio = globalThis.testAudio = new AudioContext();
    const source = audio.createOscillator(), target = audio.createMediaStreamDestination();
    source.connect(target); source.start();
    for (const track of target.stream.getTracks()) peer.addTrack(track, target.stream);
    await peer.setRemoteDescription({ type: 'offer', sdp: offer });
    await peer.setLocalDescription(await peer.createAnswer());
    if (peer.iceGatheringState !== 'complete') await new Promise(resolve => {
      peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === 'complete') resolve(); };
    });
    return peer.localDescription.sdp;
  }`;
  return {
    // A fixed test driver supplies the remote peer; production never consumes this.
    driver: `app.whenReady().then(async () => {
      const {BrowserWindow} = require('electron');
      const remote = new BrowserWindow({ show: false, webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        autoplayPolicy: 'no-user-gesture-required' } });
      await remote.loadURL('data:text/html,<title>Synthetic remote peer</title>');
      const {sdp} = await (await fetch(${JSON.stringify(`${origin}/offer`)})).json();
      const code = '(' + ${JSON.stringify(remoteScript)} + ')(' + JSON.stringify(sdp) + ')';
      const answer = await remote.webContents.executeJavaScript(code);
      await fetch(${JSON.stringify(`${origin}/answer`)}, { method: 'POST', body: answer });
    }).catch(error => process.stderr.write('Synthetic peer failed: ' + error.message));`,
    async answer(sdp: string) {
      giveOffer(sdp);
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        answer,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Synthetic peer timed out')), 8000);
        }),
      ]).finally(() => clearTimeout(timer));
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
