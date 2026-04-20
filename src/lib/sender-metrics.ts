export interface SenderMetrics {
  attempts: number;
  landed: number;
  failed: number;
  tipLamportsSpent: number;
  lastTxElapsedMs?: number;
  lastLandedAt?: number;
  lastFailedAt?: number;
}

const state: SenderMetrics = {
  attempts: 0,
  landed: 0,
  failed: 0,
  tipLamportsSpent: 0,
};

export function recordAttempt(): void {
  state.attempts++;
}

export function recordLanded(elapsedMs: number, tipLamports: number): void {
  state.landed++;
  state.tipLamportsSpent += tipLamports;
  state.lastTxElapsedMs = elapsedMs;
  state.lastLandedAt = Date.now();
}

export function recordFailed(): void {
  state.failed++;
  state.lastFailedAt = Date.now();
}

export function snapshotMetrics(): SenderMetrics {
  return { ...state };
}

export function resetMetrics(): void {
  state.attempts = 0;
  state.landed = 0;
  state.failed = 0;
  state.tipLamportsSpent = 0;
  state.lastTxElapsedMs = undefined;
  state.lastLandedAt = undefined;
  state.lastFailedAt = undefined;
}
