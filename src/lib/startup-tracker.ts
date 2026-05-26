/**
 * Tracks whether the asynchronous keeper boot (RPC connectivity probe,
 * market discovery, service start) has completed.
 *
 * The /health endpoint must return 503 until start() resolves successfully;
 * Railway otherwise marks the container healthy the moment the HTTP server
 * binds — well before the keeper can actually crank anything.
 */
export type StartupState = "starting" | "ready" | "failed";

export class StartupTracker {
  private _state: StartupState = "starting";
  private _failureReason?: string;

  markReady(): void {
    if (this._state === "failed") return;
    this._state = "ready";
  }

  markFailed(reason: string): void {
    this._state = "failed";
    this._failureReason = reason;
  }

  get state(): StartupState {
    return this._state;
  }

  get failureReason(): string | undefined {
    return this._failureReason;
  }

  isReady(): boolean {
    return this._state === "ready";
  }

  isFailed(): boolean {
    return this._state === "failed";
  }
}
