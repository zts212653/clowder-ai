const { randomUUID } = require('node:crypto');

// Ephemeral observation cache. It never writes frames or creates conversation history.
class ScreenContext {
  constructor({ now = Date.now, maxAgeMs = 5000 } = {}) {
    this.now = now;
    this.maxAgeMs = maxAgeMs;
  }
  request() {
    this.stop();
    this.selectionId = randomUUID();
    return this.selectionId;
  }
  start(selectionId, sourceLabel) {
    if (!selectionId || this.selectionId !== selectionId || this.active) return false;
    if (typeof sourceLabel !== 'string' || !sourceLabel.trim() || sourceLabel.length > 256) return false;
    this.sourceLabel = sourceLabel;
    this.active = true;
    return true;
  }
  accept(selectionId, frame) {
    if (!this.active || selectionId !== this.selectionId) return false;
    if (
      !frame ||
      typeof frame.image !== 'string' ||
      frame.image.length > 1_400_000 ||
      !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(frame.image) ||
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 1 ||
      frame.height < 1 ||
      frame.width > 1600 ||
      frame.height > 1600
    )
      return false;
    this.frame = Object.freeze({
      frameId: randomUUID(),
      sourceLabel: this.sourceLabel,
      observedAt: this.now(),
      width: frame.width,
      height: frame.height,
      image: frame.image,
    });
    return true;
  }
  current() {
    if (!this.active || !this.frame || this.now() - this.frame.observedAt > this.maxAgeMs) return undefined;
    return this.frame;
  }
  stop() {
    this.active = false;
    this.selectionId = undefined;
    this.sourceLabel = undefined;
    this.frame = undefined;
  }
}
module.exports = { ScreenContext };
