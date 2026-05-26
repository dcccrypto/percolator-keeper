/**
 * Crash + startup-failure exit pattern.
 *
 * Why a module: keeps the side-effecting bits (process.exit, Sentry capture,
 * setTimeout) injectable so we can assert call order in tests without actually
 * tearing down the test runner.
 */

export interface CaptureAndExitDeps {
  /** Sentry capture — failures here are swallowed (never block exit). */
  capture: (err: unknown) => void;
  /** Structured logger; only .error is used. */
  logger: { error: (msg: string, ctx?: Record<string, unknown>) => void };
  /** Process exit; mocked in tests so the runner stays alive. */
  exit: (code: number) => void;
  /** Scheduling primitive; mocked in tests to run synchronously. */
  setTimer: (cb: () => void, ms: number) => void;
  /** Sentry flush window before hard-exit. Default 2000ms. */
  flushMs?: number;
}

/**
 * Log, capture to Sentry, wait briefly for flush, then exit(1).
 *
 * Used by start() rejection handler and uncaughtException / unhandledRejection
 * handlers. The keeper signs against live funds — silent recovery from an
 * unhandled error risks operating with corrupt in-process state. Better to
 * crash and let Railway restart a clean process.
 */
export function captureAndExit(
  reason: string,
  err: unknown,
  deps: CaptureAndExitDeps,
): void {
  const error = err instanceof Error ? err : new Error(String(err));
  deps.logger.error(reason, {
    error: error.message,
    stack: error.stack,
  });
  try {
    deps.capture(error);
  } catch {
    // Sentry must never block exit. Network outage, DSN unset — swallow.
  }
  const flushMs = deps.flushMs ?? 2000;
  deps.setTimer(() => deps.exit(1), flushMs);
}
