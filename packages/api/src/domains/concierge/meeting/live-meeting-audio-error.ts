/** Preserve controller status without exposing its lease or the sidecar response object. */
export class LiveMeetingAudioError extends Error {
  constructor(
    readonly statusCode: number,
    operation: string,
    reason: string,
  ) {
    super(`meeting_audio_${operation}_failed:${statusCode}:${reason}`);
  }
}
