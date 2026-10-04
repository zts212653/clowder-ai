/** An attached desktop must renew its call lease; detached surfaces cannot hold the call forever. */
export class LiveSurfaceLease {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly onExpired: () => void) {}

  touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(this.onExpired, 90_000);
    this.timer.unref();
  }

  close(): void {
    clearTimeout(this.timer);
  }
}
