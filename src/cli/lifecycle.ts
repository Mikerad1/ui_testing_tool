/** Coordinates startup cancellation and one ordered, idempotent shutdown. */
export class ShutdownLifecycle {
  private requested = false;
  private ready = false;
  private cleanupPromise: Promise<void> | undefined;
  private resolveStop!: () => void;
  private readonly stopRequest = new Promise<void>(resolve => { this.resolveStop = resolve; });

  constructor(private readonly cleanup: () => Promise<void>) {}

  get stopRequested(): boolean { return this.requested; }

  requestStop(): void {
    this.requested = true;
    this.resolveStop();
    if (this.ready) void this.runCleanup().catch(() => undefined);
  }

  /** Mark setup complete. A signal received earlier is cleaned up only now. */
  markReady(): void {
    this.ready = true;
    if (this.requested) void this.runCleanup().catch(() => undefined);
  }

  waitForStopRequest(): Promise<void> { return this.stopRequest; }

  /** Used by the serve finally path, including startup failures before readiness. */
  shutdown(): Promise<void> { return this.runCleanup(); }

  private runCleanup(): Promise<void> {
    return this.cleanupPromise ?? (this.cleanupPromise = Promise.resolve().then(this.cleanup));
  }
}
