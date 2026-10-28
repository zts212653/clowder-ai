export type WorkVideoFrame = { canvas: HTMLCanvasElement; duration?: number };
type FrameJob = { url: string; receive: (frame: WorkVideoFrame | null) => void; cancel?: () => void };

// Shared by Works, recent works and chat: a preview must leave connections for ordinary API reads.
const waiting: FrameJob[] = [];
const active = new Set<FrameJob>();
const MAX_READERS = 2;

export function requestWorkVideoFrame(url: string, receive: FrameJob['receive']) {
  const job: FrameJob = { url, receive };
  waiting.push(job);
  pump();
  return () => {
    const index = waiting.indexOf(job);
    if (index >= 0) waiting.splice(index, 1);
    job.cancel?.();
  };
}

function pump() {
  while (active.size < MAX_READERS && waiting.length) {
    const job = waiting.shift();
    if (job) start(job);
  }
}

function start(job: FrameJob) {
  active.add(job);
  const video = document.createElement('video');
  let finished = false;
  let seekComplete = false;
  const finish = (frame: WorkVideoFrame | null, notify = true) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
    // Removing the element alone does not abort a media range read. Explicitly unload before the next job.
    video.removeAttribute('src');
    video.load();
    active.delete(job);
    try {
      if (notify) job.receive(frame);
    } finally {
      pump();
    }
  };
  const timeout = setTimeout(() => finish(null), 6000);
  job.cancel = () => finish(null, false);
  const capture = () => {
    if (video.readyState < 2 || video.seeking || !seekComplete || !video.videoWidth) return;
    finish(captureFrame(video));
  };
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.onloadedmetadata = () => {
    const target = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(4, video.duration * 0.3) : 0;
    seekComplete = target === 0;
    try {
      if (target) video.currentTime = target;
    } catch {
      finish(null);
    }
  };
  video.onloadeddata = capture;
  video.onseeked = () => {
    seekComplete = true;
    capture();
  };
  video.onerror = () => finish(null);
  video.src = job.url;
}

function captureFrame(video: HTMLVideoElement): WorkVideoFrame | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(640, video.videoWidth);
    canvas.height = Math.max(1, Math.round((canvas.width * video.videoHeight) / video.videoWidth));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined;
    return { canvas, duration };
  } catch {
    return null;
  }
}
