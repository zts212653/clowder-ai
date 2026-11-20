import { Session } from 'node:inspector';
import { parentPort, workerData } from 'node:worker_threads';

const original = Session.prototype.post;
let releaseDisable;
parentPort.on('message', (message) => {
  if (message.type === 'test-release-disable') releaseDisable?.();
});
Session.prototype.post = function (method, params, callback) {
  if (typeof params === 'function') {
    callback = params;
    params = {};
  }
  if (method === 'Profiler.start') {
    if (workerData.fault === 'exit-after-start')
      return original.call(this, method, params, (error) => {
        parentPort.postMessage({ type: 'test-control', stage: 'start-dispatched', failed: Boolean(error) });
        process.exit(0);
      });
    return original.call(this, method, params, (error, response) => {
      setTimeout(() => {
        parentPort.postMessage({ type: 'test-control', stage: 'start-delivered' });
        if (workerData.fault === 'start-error') {
          parentPort.postMessage({ type: 'test-control', stage: 'fault-injected' });
          callback(Error('controlled start error after real start'), response);
        } else callback(error, response);
      }, 1750);
    });
  }
  if (method === 'Profiler.stop' && workerData.fault === 'stop-error')
    return original.call(this, method, params, (_error, response) => {
      parentPort.postMessage({ type: 'test-control', stage: 'fault-injected' });
      callback(Error('controlled stop error after real stop'), response);
    });
  if (method === 'Profiler.disable') {
    if (workerData.teardown === 'reject') {
      parentPort.postMessage({ type: 'test-control', stage: 'disable-rejected' });
      queueMicrotask(() => callback(Error('controlled disable rejection')));
      return;
    }
    return original.call(this, method, params, (error, response) => {
      releaseDisable = () => callback(error, response);
      parentPort.postMessage({ type: 'test-control', stage: 'disable-held' });
    });
  }
  return original.call(this, method, params, callback);
};
await import(workerData.entry);
