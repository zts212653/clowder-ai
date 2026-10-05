const { EventEmitter } = require('node:events');
const { ORIGIN } = require('./policy.cjs');
const { hostResponseError } = require('./host-errors.cjs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const healthValues = new Set([
  'new',
  'checking',
  'connecting',
  'connected',
  'completed',
  'disconnected',
  'failed',
  'closed',
  'stable',
  'have-local-offer',
  'have-remote-offer',
  'user-ended',
  'disconnect-timeout',
  'data-channel-closed',
  'transport-failed',
  'transport-closed',
  'start-timeout',
  'fixture-failed',
  'provider-data-error',
  'start-failed',
  'answer-failed',
  'native-failure',
  'native-closed',
  'document-access-changed',
  'document-access-revoked',
]);
const healthValue = (value) => (healthValues.has(value) ? value : 'unclassified');

/** Electron-main adapter. Session cookies and Host handles never cross into renderer code. */
class HostApiHost extends EventEmitter {
  constructor({
    apiUrl,
    allowHomeReads = false,
    fetcher = fetch,
    reportHealth = (value) => console.info('[F317 Live health]', JSON.stringify(value)),
  }) {
    super();
    const url = new URL(apiUrl);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Live Host requires an explicit loopback API origin');
    this.apiUrl = url.origin;
    this.allowHomeReads = allowHomeReads;
    this.fetcher = fetcher;
    this.reportHealth = reportHealth;
    this.generation = 0;
    this.child = null;
    this.hostBacked = true;
  }
  // Canonical transcripts belong to Host. Renderer transcript/typed-input events are never written to a second history.
  record(event) {
    if (!['error', 'transport', 'stopping', 'stopped'].includes(event?.type)) return;
    const health = { type: event.type, at: new Date().toISOString(), callId: this.child?.callId };
    if (event.type === 'transport') {
      for (const field of ['state', 'ice', 'signaling']) health[field] = healthValue(event[field]);
    } else if (event.type !== 'stopped') health.reason = healthValue(event.reason);
    // Never persist transcripts, typed input, SDP, provider error bodies, or cookies here.
    this.reportHealth(health);
  }
  async requestApi(path, method = 'GET', body, timeout = 10_000) {
    const response = await this.fetcher(`${this.apiUrl}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      headers: {
        origin: ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (path === '/api/session') {
      const cookie = response.headers.get('set-cookie');
      if (cookie) this.cookie = cookie.split(';')[0];
    }
    if (method === 'DELETE' && response.status === 404) return { stopped: true };
    if (!response.ok) throw await hostResponseError(response);
    return response.json();
  }
  prepare() {
    if (this.pending) return this.pending;
    if (this.child) throw new Error('Voice session already running');
    const generation = ++this.generation;
    const operation = this.initialize(generation);
    this.pending = operation;
    void operation
      .finally(() => {
        if (this.pending === operation) this.pending = null;
      })
      .catch(() => {});
    return operation;
  }
  async initialize(generation) {
    await this.requestApi('/api/session');
    if (generation !== this.generation) throw new Error('语音准备已取消');
    const call = await this.requestApi('/api/concierge/live', 'POST', {
      allowHomeReads: this.allowHomeReads,
    });
    if (generation !== this.generation) {
      await this.requestApi(`/api/concierge/live/${call.callId}`, 'DELETE');
      throw new Error('语音准备已取消');
    }
    this.child = { callId: call.callId };
    const deadline = Date.now() + 60_000;
    let status = call;
    try {
      while (status.state === 'preparing' && generation === this.generation && Date.now() < deadline) {
        await wait(200);
        status = await this.requestApi(`/api/concierge/live/${call.callId}`);
      }
      if (generation !== this.generation || status.state !== 'ready') throw new Error('语音准备尚未完成');
      this.publishStatus(status);
      this.pollTimer = setInterval(() => void this.poll(generation), 2000);
      this.pollTimer.unref?.();
    } catch (error) {
      if (this.child?.callId === call.callId) {
        this.child = null;
        await this.requestApi(`/api/concierge/live/${call.callId}`, 'DELETE').catch(() => {});
      }
      throw error;
    }
  }
  publishStatus(status) {
    if (['closed', 'failed'].includes(status.state)) {
      this.toolsReady = false;
      this.emit('event', { type: 'closed', reason: `Host call ${status.state}` });
      return;
    }
    if (status.toolsReady && !this.toolsReady) this.emit('event', { type: 'tools-ready', state: 'connected' });
    this.toolsReady = status.toolsReady === true;
  }
  async poll(generation) {
    if (this.polling || generation !== this.generation || !this.child) return;
    this.polling = true;
    try {
      const status = await this.requestApi(`/api/concierge/live/${this.child.callId}`);
      if (generation === this.generation) this.publishStatus(status);
    } catch {
      if (generation === this.generation) this.emit('event', { type: 'closed', reason: 'Host connection unavailable' });
    } finally {
      this.polling = false;
    }
  }
  launch() {
    if (!this.child) throw new Error('Host session is not ready');
  }
  async request(method, data = {}) {
    if (!this.child) throw new Error('Host session is not ready');
    const path = `/api/concierge/live/${this.child.callId}`;
    if (method === 'start') {
      const generation = this.generation;
      const result = await this.requestApi(`${path}/start`, 'POST', { offer: data.sdp }, 65_000);
      if (generation !== this.generation) throw new Error('语音已结束');
      this.emit('event', { type: 'answer', sdp: result.answer });
      return result;
    }
    if (method === 'text') {
      const receipt = await this.requestApi(`${path}/text`, 'POST', {
        text: data.text,
        clientMessageId: data.clientMessageId,
      });
      if (receipt.delivery !== 'accepted') throw new Error('这句话已保存，尚未确认猫收到；可以稍后重试');
      return receipt;
    }
    if (method === 'screen-open')
      return this.requestApi(`${path}/screen`, 'POST', {
        kind: 'open',
        selectionId: data.selectionId,
        label: data.label,
      });
    if (method === 'screen')
      return this.requestApi(
        `${path}/screen`,
        'POST',
        data.observation
          ? { kind: 'frame', selectionId: data.selectionId, frame: data.observation }
          : { kind: 'close' },
      );
    throw new Error('Unsupported Host operation');
  }
  async stop() {
    ++this.generation;
    clearInterval(this.pollTimer);
    const call = this.child;
    this.child = null;
    this.toolsReady = false;
    try {
      if (call) await this.requestApi(`/api/concierge/live/${call.callId}`, 'DELETE');
    } finally {
      await this.pending?.catch(() => {});
    }
  }
}
module.exports = { HostApiHost };
