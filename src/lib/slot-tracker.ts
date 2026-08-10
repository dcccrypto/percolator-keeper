import { createLogger } from "@percolatorct/shared";

const logger = createLogger("keeper:slot-tracker");

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_DRIFT_ALERT_SLOTS = 50;
const DEFAULT_DRIFT_ALERT_COOLDOWN_MS = 5 * 60_000;

export class SlotTracker {
  private streamSlot = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _lastDriftAlertMs = 0;
  private readonly driftAlertSlots: number;
  private readonly driftAlertCooldownMs: number;
  private readonly onDriftAlert: ((drift: number) => void) | undefined;

  constructor(onDriftAlert?: (drift: number) => void) {
    this.driftAlertSlots =
      parseInt(process.env.KEEPER_STREAM_SLOT_DRIFT_ALERT ?? "", 10) ||
      DEFAULT_DRIFT_ALERT_SLOTS;
    this.driftAlertCooldownMs =
      parseInt(process.env.KEEPER_STREAM_DRIFT_ALERT_COOLDOWN_MS ?? "", 10) ||
      DEFAULT_DRIFT_ALERT_COOLDOWN_MS;
    this.onDriftAlert = onDriftAlert;
  }

  onStreamSlot(slot: number): void {
    if (slot > this.streamSlot) {
      this.streamSlot = slot;
    }
  }

  getStreamSlot(): number {
    return this.streamSlot;
  }

  /** Positive value means the stream is behind the RPC. */
  getDriftEstimate(rpcSlot: number): number {
    return rpcSlot - this.streamSlot;
  }

  /**
   * Polls getRpcSlot every 10 seconds and emits a warning if the stream slot
   * has drifted more than driftAlertSlots behind the RPC.
   */
  start(getRpcSlot: () => Promise<number>): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        const rpcSlot = await getRpcSlot();
        const drift = this.getDriftEstimate(rpcSlot);
        // streamSlot === 0 means the stream has not delivered a slot yet (still
        // connecting): drift = rpcSlot, a meaninglessly huge value that would
        // otherwise fire on the very first poll and every 10s after. Only alert
        // once the stream is live, and rate-limit to the cooldown so a sustained
        // real lag does not spam Discord every poll (every other alert path in
        // the keeper has a cooldown; this one did not).
        if (this.streamSlot > 0 && drift > this.driftAlertSlots) {
          const now = Date.now();
          if (now - this._lastDriftAlertMs >= this.driftAlertCooldownMs) {
            this._lastDriftAlertMs = now;
            logger.warn("Stream slot drift exceeds threshold", {
              streamSlot: this.streamSlot,
              rpcSlot,
              drift,
              threshold: this.driftAlertSlots,
            });
            this.onDriftAlert?.(drift);
          }
        }
      } catch (err) {
        logger.warn("SlotTracker: failed to poll RPC slot", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
