function createLifecycleLogger(dbg) {
  return (event, details = {}) => {
    const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
    dbg(`[lifecycle] ${event}${suffix}`);
  };
}

module.exports = { createLifecycleLogger };
