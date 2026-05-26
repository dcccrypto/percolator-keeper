const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const DEFAULT_CAP_MS = 30_000;

function parseBackoffSequence(): number[] {
  const raw = process.env.KEEPER_LASERSTREAM_RECONNECT_BACKOFF_MS?.trim();
  if (!raw) return DEFAULT_BACKOFF_MS;
  const parsed = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : DEFAULT_BACKOFF_MS;
}

/**
 * Pure exponential backoff state machine.
 * Caller is responsible for scheduling — this class never sets timers.
 */
export class ReconnectBackoff {
  private readonly sequence: number[];
  private readonly cap: number;
  private _failures = 0;

  constructor() {
    this.sequence = parseBackoffSequence();
    this.cap = this.sequence[this.sequence.length - 1] ?? DEFAULT_CAP_MS;
  }

  nextDelay(): number {
    const idx = Math.min(this._failures, this.sequence.length - 1);
    this._failures++;
    return this.sequence[idx] ?? this.cap;
  }

  reset(): void {
    this._failures = 0;
  }

  consecutiveFailures(): number {
    return this._failures;
  }
}
