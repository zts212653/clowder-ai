const { ScreenContext } = require('../companion-live/screen-context.cjs');
const gestureActions = new Set([
  'prepare',
  'documents',
  'screen.pick',
  'conversation.open',
  'decision.open',
  'text',
  'settings.update',
  'companion.disable',
]);
const denied = (code = 'permission_required') => ({ kind: 'error', code });

/** Privileged media admission belongs to the Host-owned window, not its package. */
function createCompanionController({ request, publish, resize, stopCapture = () => {} }) {
  let armed = false;
  let generation = 0;
  let ended = false;
  let surfaceCaptureGranted = false;
  const screen = new ScreenContext();
  const stopLocal = (reason) => {
    const mustRevokeSurface = surfaceCaptureGranted;
    surfaceCaptureGranted = false;
    ++generation;
    armed = false;
    screen.stop();
    publish({ kind: 'media-stopped', reason });
    // Audio lives in the Host media document and is destroyed by publish().
    // Only a possible renderer-owned screen capture requires a document reload.
    if (mustRevokeSurface) stopCapture();
  };
  return {
    get armed() {
      return armed && !ended;
    },
    display(permission, mediaTypes) {
      return (
        !ended &&
        armed &&
        !screen.active &&
        Boolean(screen.selectionId) &&
        (permission === 'display-capture' ||
          (permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.length === 0))
      );
    },
    async request(command, activated) {
      if (ended || !command || typeof command.kind !== 'string') return denied('invalid_request');
      if (gestureActions.has(command.kind) && activated !== true) return denied();
      if (command.kind === 'prepare') {
        if (armed) return denied('busy');
        const current = ++generation;
        const result = await request(command);
        if (ended || current !== generation) return denied('cancelled');
        armed = result.kind === 'state' && result.phase === 'ready';
        return result;
      }
      if (command.kind === 'stop' || command.kind === 'documents') stopLocal('revoked');
      if (command.kind === 'screen.pick') {
        if (!armed) return denied();
        // Sticky until Host revocation: a package's screen.close claim cannot
        // prove it released its MediaStream or an in-flight system picker.
        surfaceCaptureGranted = true;
        return { kind: 'selection', selectionId: screen.request() };
      }
      if (command.kind === 'screen.open') {
        if (!armed || !screen.start(command.selectionId, command.label)) return denied();
      }
      if (command.kind === 'screen.frame') {
        if (!armed || !screen.accept(command.selectionId, command.frame)) return denied();
        return request({ ...command, frame: screen.current() });
      }
      if (command.kind === 'screen.close') screen.stop();
      if (command.kind === 'offer' && !armed) return denied();
      if (command.kind === 'view.resize') {
        if (typeof command.expanded !== 'boolean') return denied('invalid_request');
        resize(command.expanded);
        return { kind: 'ok' };
      }
      const current = generation;
      const result = await request(command);
      if (['state', 'screen.open', 'offer'].includes(command.kind) && (current !== generation || ended))
        return denied('cancelled');
      if (
        command.kind === 'state' &&
        armed &&
        (result.kind === 'error' || (result.kind === 'state' && ['idle', 'closed', 'failed'].includes(result.phase)))
      ) {
        stopLocal('revoked');
        void request({ kind: 'stop' }).catch(() => {});
      }
      if (command.kind === 'screen.open' && result.kind === 'error') {
        stopLocal('revoked');
        void request({ kind: 'stop' }).catch(() => {});
      }
      return result;
    },
    suspend(reason) {
      stopLocal(reason);
      void request({ kind: 'stop' }).catch(() => {});
    },
    close() {
      if (ended) return;
      ended = true;
      stopLocal('closed');
    },
  };
}
module.exports = { createCompanionController };
