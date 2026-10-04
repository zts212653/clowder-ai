/** Native policy consumes only trusted Host replies. Media preparation is a
 * separate authority; neither renderer preferences nor call state can arm it. */
function createWindowPreferences({ motion, setBallSize }) {
  let behaviorEnabled = false;
  let epoch = 0;
  const sequences = { state: 0, settings: 0 };
  let panelBlocked = false;
  let dragActive = false;
  let disabled = false;
  const pendingMutations = new Set();
  const suspended = new Set();
  const stateReads = new Set(['state', 'prepare', 'documents']);
  const suspend = (reason) => {
    ++epoch;
    behaviorEnabled = false;
    suspended.add(reason);
    motion.revoke(reason);
  };
  const resume = (reason) => {
    ++epoch;
    suspended.delete(reason);
    // A fresh Host read is required after a privacy/visibility boundary.
  };
  return {
    allowed: () =>
      behaviorEnabled && !disabled && !pendingMutations.size && !suspended.size && !panelBlocked && !dragActive,
    begin(command, activated) {
      if (['settings.update', 'companion.disable'].includes(command.kind) && activated !== true) return null;
      const group = stateReads.has(command.kind)
        ? 'state'
        : ['settings.read', 'settings.update', 'companion.disable'].includes(command.kind)
          ? 'settings'
          : null;
      if (!group) return null;
      const mutation =
        command.kind === 'companion.disable' ||
        (command.kind === 'settings.update' && command.field === 'behaviorEnabled');
      if (mutation) {
        ++epoch;
        behaviorEnabled = false;
        motion.revoke('preference_change_pending');
      }
      const ticket = { epoch, group, sequence: ++sequences[group], mutation };
      if (mutation) pendingMutations.add(ticket);
      return ticket;
    },
    accept(ticket, reply) {
      if (ticket?.mutation && pendingMutations.delete(ticket)) {
        // Even an outdated mutation must settle its own pending slot. Never
        // reuse a read that began before this settlement boundary.
        ++epoch;
        behaviorEnabled = false;
        if (reply.kind === 'companion-lifecycle' && reply.action === 'disable' && reply.outcome === 'disabled')
          disabled = true;
        motion.revoke('preference_settled');
        return;
      }
      if (
        !ticket ||
        pendingMutations.size ||
        disabled ||
        ticket.epoch !== epoch ||
        ticket.sequence !== sequences[ticket.group] ||
        suspended.size
      )
        return;
      if (reply.kind === 'state') {
        behaviorEnabled = reply.behaviorEnabled === true;
        if (behaviorEnabled) motion.arm();
        else motion.revoke('behavior_disabled_or_unknown');
      } else if (reply.kind === 'settings' && reply.status === 'available') {
        if (setBallSize(reply.values.ballSize)) {
          motion.revoke('geometry_changed');
          motion.arm();
        }
      } else if (reply.kind === 'error') {
        behaviorEnabled = false;
        motion.revoke('preference_unavailable');
      }
    },
    presentation(command, reply) {
      if (command.kind === 'view.layout' && reply.kind === 'layout') {
        panelBlocked = command.panel !== 'none';
        if (panelBlocked) motion.revoke('panel_open');
        else motion.arm();
      }
      if (command.kind === 'view.drag' && reply.kind === 'ok') {
        dragActive = command.phase === 'start';
        if (dragActive) motion.revoke('manual_drag');
        else motion.arm();
      }
    },
    suspend,
    resume,
    watchPower(powerMonitor, revokeMedia) {
      const listeners = {
        'lock-screen': () => {
          suspend('locked');
          revokeMedia('locked');
        },
        suspend: () => {
          suspend('suspended');
          revokeMedia('suspended');
        },
        'unlock-screen': () => resume('locked'),
        resume: () => resume('suspended'),
      };
      for (const [event, listener] of Object.entries(listeners)) powerMonitor.on(event, listener);
      return () => {
        for (const [event, listener] of Object.entries(listeners)) powerMonitor.off(event, listener);
      };
    },
  };
}

module.exports = { createWindowPreferences };
