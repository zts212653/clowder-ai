/* Built-in frame surface: no installed-plugin gate, source components stay in their own bundle. */
'use strict';
VM.starryFrame = function () {
  return { src: '/frames/starry' };
};
A.starryFrameMessage = function (data, frame, event) {
  return window.clowderFrameRequest(data, frame, event);
};
