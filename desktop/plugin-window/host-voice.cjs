class HostVoice {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.closed = false;
    this.micMuted = false;
    this.speakerMuted = false;
    this.playbackSamples = new Map();
    this.reportedOutput = new Set();
  }
  async offer({ microphone = 'capture' } = {}) {
    if (this.closed) throw new Error('已结束');
    if (microphone !== 'capture' && microphone !== 'none') throw new Error('无效麦克风模式');
    this.receiveOnly = microphone === 'none';
    if (!this.receiveOnly) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (this.closed) {
        this.stream.getTracks().forEach((track) => {
          track.stop();
        });
        throw new Error('已结束');
      }
    }
    this.pc = new RTCPeerConnection();
    if (this.receiveOnly) {
      this.pc.addTransceiver('audio', { direction: 'recvonly' });
    } else {
      for (const track of this.stream.getTracks()) {
        track.enabled = !this.micMuted;
        this.pc.addTrack(track, this.stream);
      }
    }
    this.channel = this.pc.createDataChannel('oai-events');
    this.channel.onmessage = (event) => {
      try {
        const value = JSON.parse(event.data);
        if (value.type === 'input_transcript.added' || value.type === 'output_transcript.added') {
          const text = value.item?.text;
          if (typeof text === 'string')
            this.onEvent({
              type: 'transcript',
              role: value.type.startsWith('input') ? 'user' : 'assistant',
              text,
              itemId: value.item?.id,
              turnId: value.turn_id,
            });
        }
        if (value.type === 'turn.created' && value.turn?.role === 'user')
          this.onEvent({ type: 'turn-created', role: 'user', turnId: value.turn.id });
        if (value.type === 'turn.created' && value.turn?.role === 'assistant') this.outputTurnId = value.turn.id;
        if (value.type === 'error') this.onEvent({ type: 'error', code: 'unavailable' });
        if (value.type === 'turn.done')
          this.onEvent({
            type: 'turn-done',
            role: value.turn?.role,
            transcript: value.turn?.transcript,
            turnId: value.turn?.id,
          });
        if (value.type === 'turn.done' && value.turn?.role === 'user')
          this.onEvent({
            type: 'response-observation',
            stage: 'owner_voice_completed',
            turnId: value.turn.id,
            observedAt: Date.now(),
          });
      } catch {
        /* provider data channel can contain non-transcript events */
      }
    };
    this.channel.onopen = () => this.onEvent({ type: 'connected' });
    this.channel.onclose = () => {
      if (!this.closed)
        this.onEvent({ type: 'error', reason: 'data-channel-closed', message: '语音通道已关闭 · 点击聊聊继续' });
    };
    this.pc.onconnectionstatechange = () => this.connectionChanged();
    await this.pc.setLocalDescription(await this.pc.createOffer());
    if (this.pc.iceGatheringState !== 'complete')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('网络连接准备超时')), 8000);
        this.pc.onicegatheringstatechange = () => {
          if (this.pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        };
      });
    if (this.closed) throw new Error('已结束');
    return this.pc.localDescription.sdp;
  }
  async answer(sdp) {
    if (this.closed) return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    if (this.closed) return;
    const tracks = this.pc
      .getReceivers()
      .map((r) => r.track)
      .filter((t) => t.kind === 'audio');
    const stream = new MediaStream(tracks);
    this.output = new Audio();
    this.output.muted = this.speakerMuted;
    this.output.autoplay = true;
    this.output.srcObject = stream;
    await this.output.play();
    if (!this.closed && this.pc.getStats)
      this.playbackTimer = setInterval(() => {
        void this.samplePlayback().catch(() => {});
      }, 250);
  }
  /** Local playback and received nonzero energy, not proof of the system output device being audible. */
  async samplePlayback() {
    if (this.closed || this.sampling || !this.pc?.getStats || !this.output) return;
    const turnId = this.outputTurnId;
    this.sampling = true;
    try {
      const reports = await this.pc.getStats();
      if (this.closed || turnId !== this.outputTurnId) return;
      const clock = this.output.currentTime;
      const advanced = Number.isFinite(this.previousClock) && clock > this.previousClock;
      this.previousClock = clock;
      let nonzero = false;
      for (const report of reports.values()) {
        if (report.type !== 'inbound-rtp' || (report.kind ?? report.mediaType) !== 'audio') continue;
        const { id, totalAudioEnergy: energy, bytesReceived: bytes } = report;
        if (typeof id !== 'string' || !Number.isFinite(energy) || !Number.isFinite(bytes)) continue;
        const prior = this.playbackSamples.get(id);
        if (prior && energy > prior.energy && bytes > prior.bytes) nonzero = true;
        if (this.playbackSamples.has(id) || this.playbackSamples.size < 16)
          this.playbackSamples.set(id, { energy, bytes });
      }
      if (
        advanced &&
        nonzero &&
        !this.output.muted &&
        !this.output.paused &&
        this.output.volume > 0 &&
        /^[A-Za-z0-9_-]{1,160}$/.test(turnId ?? '') &&
        !this.reportedOutput.has(turnId) &&
        this.reportedOutput.size < 4096
      ) {
        this.reportedOutput.add(turnId);
        this.onEvent({ type: 'response-observation', stage: 'first_audio_output', turnId, observedAt: Date.now() });
      }
    } finally {
      this.sampling = false;
    }
  }
  muteMic(muted) {
    if (this.receiveOnly && !muted) return false;
    this.micMuted = muted;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    return true;
  }
  connectionChanged() {
    if (this.closed) return;
    const state = this.pc.connectionState;
    this.onEvent({ type: 'transport', state, ice: this.pc.iceConnectionState, signaling: this.pc.signalingState });
    if (state === 'disconnected') {
      if (this.disconnectTimer) return;
      this.onEvent({ type: 'recovering' });
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = undefined;
        if (!this.closed && this.pc.connectionState !== 'connected')
          this.onEvent({ type: 'error', reason: 'disconnect-timeout', message: '连接未恢复 · 点击聊聊继续' });
      }, 8000);
    } else if (['connected', 'failed', 'closed'].includes(state)) {
      const recovering = Boolean(this.disconnectTimer);
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = undefined;
      if (state === 'connected') {
        if (recovering) this.onEvent({ type: 'recovered' });
      } else {
        this.onEvent({ type: 'error', reason: `transport-${state}`, message: '语音连接已中断 · 点击聊聊继续' });
      }
    }
  }
  muteSpeaker(muted) {
    this.speakerMuted = muted;
    if (this.output) this.output.muted = muted;
  }
  async close() {
    this.closed = true;
    clearInterval(this.playbackTimer);
    this.playbackSamples.clear();
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    this.output?.pause();
    if (this.output) this.output.srcObject = null;
    this.pc?.close();
  }
}

module.exports = { HostVoice };
