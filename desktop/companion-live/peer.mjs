export class VoicePeer {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.recordings = [];
    this.closed = false;
    this.micMuted = false;
    this.speakerMuted = false;
  }
  async offer(synthetic) {
    this.synthetic = synthetic;
    this.audio = new AudioContext();
    await this.audio.resume();
    if (synthetic) {
      this.destination = this.audio.createMediaStreamDestination();
      this.silence = this.audio.createConstantSource();
      this.silence.offset.value = 0;
      this.silence.connect(this.destination);
      this.silence.start();
      this.stream = this.destination.stream;
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    }
    if (this.closed) {
      this.stream.getTracks().forEach((track) => {
        track.stop();
      });
      throw new Error('已结束');
    }
    this.pc = new RTCPeerConnection();
    for (const track of this.stream.getTracks()) {
      track.enabled = !this.micMuted;
      this.pc.addTrack(track, this.stream);
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
        if (value.type === 'error') this.onEvent({ type: 'error', message: value.error?.message || '语音连接异常' });
        if (value.type === 'turn.done')
          this.onEvent({
            type: 'turn-done',
            role: value.turn?.role,
            transcript: value.turn?.transcript,
            turnId: value.turn?.id,
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
    if (this.synthetic) {
      this.recorder = new MediaRecorder(stream);
      this.recorder.ondataavailable = (e) => {
        if (e.data.size) this.recordings.push(e.data);
      };
      this.recorder.start(500);
      // Verification keeps the first minute, even if the test window stays open.
      this.recordingDeadline = setTimeout(() => {
        if (this.recorder.state === 'recording') this.recorder.stop();
      }, 60_000);
    }
  }
  async playFixture(base64) {
    if (!this.synthetic || this.closed) return;
    const buffer = await this.audio.decodeAudioData(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer);
    const source = this.audio.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);
    source.start();
  }
  muteMic(muted) {
    this.micMuted = muted;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
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
  async stats() {
    const inbound = [];
    for (const row of (await this.pc.getStats()).values())
      if (row.type === 'inbound-rtp' && row.kind === 'audio')
        inbound.push({ bytesReceived: row.bytesReceived, totalAudioEnergy: row.totalAudioEnergy });
    return {
      type: 'media',
      synthetic: this.synthetic,
      connection: this.pc.connectionState,
      channel: this.channel.readyState,
      microphoneCaptured: !this.synthetic,
      playback: this.playbackState(),
      inbound,
    };
  }
  playbackState() {
    return {
      outputCreated: Boolean(this.output),
      paused: this.output?.paused ?? null,
      muted: this.output?.muted ?? this.speakerMuted,
      volume: this.output?.volume ?? null,
      readyState: this.output?.readyState ?? null,
      sinkId: this.output?.sinkId || 'default',
      audioContextState: this.audio?.state ?? null,
    };
  }
  async close() {
    this.closed = true;
    clearTimeout(this.recordingDeadline);
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
    this.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    if (this.recorder?.state === 'recording')
      await new Promise((resolve) => {
        this.recorder.onstop = resolve;
        this.recorder.stop();
      });
    this.output?.pause();
    if (this.output) this.output.srcObject = null;
    this.pc?.close();
    this.silence?.stop();
    await this.audio?.close().catch(() => {});
    if (!this.recordings.length) return '';
    const bytes = new Uint8Array(await new Blob(this.recordings, { type: 'audio/webm' }).arrayBuffer());
    if (bytes.length > 5_000_000) return '';
    let value = '';
    for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(value);
  }
}
