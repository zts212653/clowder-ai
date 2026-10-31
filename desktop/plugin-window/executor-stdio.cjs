function createExecutorStdio(stdout, stderr, onDisconnect) {
  let protocolClosed = false;
  let diagnosticsClosed = false;
  const disconnected = () => {
    if (protocolClosed) return;
    protocolClosed = true;
    onDisconnect();
  };
  // Writable errors are emitted even when write() has an error callback.
  // Keep these listeners through shutdown: queued writes may fail after close.
  stdout.on('error', disconnected);
  stderr.on('error', () => {
    diagnosticsClosed = true;
  });
  return {
    diagnostic(line) {
      if (diagnosticsClosed || stderr.destroyed || stderr.writableEnded) return false;
      try {
        return stderr.write(line, (error) => {
          if (error) diagnosticsClosed = true;
        });
      } catch {
        diagnosticsClosed = true;
        return false;
      }
    },
    write(frame, callback) {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        callback?.(error);
        if (error) disconnected();
      };
      if (protocolClosed || stdout.destroyed || stdout.writableEnded) {
        const error = Object.assign(new Error('Desktop protocol channel closed'), { code: 'EPIPE' });
        queueMicrotask(() => finish(error));
        disconnected();
        return false;
      }
      try {
        return stdout.write(frame, finish);
      } catch (error) {
        queueMicrotask(() => finish(error));
        disconnected();
        return false;
      }
    },
    close() {
      protocolClosed = true;
    },
  };
}
module.exports = { createExecutorStdio };
