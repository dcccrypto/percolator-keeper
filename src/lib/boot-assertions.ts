/**
 * Boot-time invariants the keeper refuses to start without.
 *
 * Why these live in a dedicated module: index.ts performs heavy side effects
 * at module load (Sentry init, service construction, interval registration),
 * which makes the boot path hard to unit-test. Pure assertions live here so
 * they can be exercised in isolation.
 */

/**
 * The single program id the keeper is authorized to sign mainnet txs against.
 * Sourced from the v12.19.1 hotfix deploy (slot 419199595, program upgrade
 * authority on file). Hardcoded — never read from env on mainnet — so a typo
 * or stale config cannot redirect the keeper to a different program.
 */
export const MAINNET_PROGRAM_ID =
  "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv";

/**
 * Refuse to boot when NETWORK=mainnet but the configured program id is not
 * the canonical mainnet program. Catches the failure mode where the keeper
 * is pointed at mainnet RPC but a devnet/test program id is still in the
 * config — which would cause real user funds to be signed against the
 * wrong program.
 */
export function assertMainnetProgramId(opts: {
  isMainnet: boolean;
  programId: string;
}): void {
  if (!opts.isMainnet) return;
  if (opts.programId === MAINNET_PROGRAM_ID) return;
  throw new Error(
    `SECURITY: NETWORK=mainnet but PROGRAM_ID=${opts.programId} — ` +
      `expected ${MAINNET_PROGRAM_ID}. Refusing to boot to prevent signing ` +
      `transactions against an unintended program.`,
  );
}
