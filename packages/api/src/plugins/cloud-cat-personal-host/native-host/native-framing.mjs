export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export function encodeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length === 0) throw new Error('Native message length must be positive');
  if (payload.length > MAX_NATIVE_MESSAGE_BYTES) throw new Error('Native message is too large');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class NativeMessageDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Native message chunk must be a Buffer');
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length === 0) throw new Error('Native message length must be positive');
      if (length > MAX_NATIVE_MESSAGE_BYTES) throw new Error('Native message is too large');
      if (this.#buffer.length < 4 + length) break;
      const payload = this.#buffer.subarray(4, 4 + length).toString('utf8');
      this.#buffer = this.#buffer.subarray(4 + length);
      const parsed = JSON.parse(payload);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Native message payload must be an object');
      }
      messages.push(parsed);
    }
    return messages;
  }

  finish() {
    if (this.#buffer.length !== 0) throw new Error('Native message stream ended with a truncated frame');
  }
}
