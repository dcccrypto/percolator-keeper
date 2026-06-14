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

/**
 * Validate config.allProgramIds — the program set the keeper actually DISCOVERS
 * and SIGNS against. assertMainnetProgramId() above guards only config.programId
 * (the single id used for tx construction), but discovery scans EVERY entry of
 * config.allProgramIds (crank.ts) and stamps each market with the scanned id,
 * which the keeper then signs KeeperCrank/LiquidateAtOracle/UpdateHyperpMark
 * against. allProgramIds is sourced independently from ALL_PROGRAM_IDS env, so
 * it must be validated separately.
 *
 * Two failure modes, two checks:
 *   1. Empty set — ANY network. `ALL_PROGRAM_IDS=""` (or `","`) survives the
 *      `?? PROGRAM_ID` fallback (empty string is not nullish) and `.filter(Boolean)`
 *      yields []. The keeper would boot "healthy" yet scan zero programs and
 *      silently crank/liquidate nothing — a misconfig on devnet too, so we catch
 *      it everywhere (before it can ride a release to mainnet).
 *   2. Non-canonical entry — MAINNET only. A foreign id injected via
 *      ALL_PROGRAM_IDS would make discovery scan, and the keeper sign against, an
 *      unintended program with the live keeper key.
 *
 * Ordering matters: the non-empty check MUST come first. `[].every(...)` is
 * vacuously true, so an empty array would otherwise pass a per-entry check and
 * re-open failure mode 1.
 */
export function assertProgramIdAllowList(opts: {
  isMainnet: boolean;
  allProgramIds: readonly string[];
}): void {
  // (1) Non-empty — all networks. Checked first to avoid the .every()/.filter()
  //     vacuous-truth trap on an empty array.
  if (opts.allProgramIds.length === 0) {
    throw new Error(
      "SECURITY: ALL_PROGRAM_IDS resolved to an empty program set — the keeper " +
        "would scan zero programs and silently crank/liquidate nothing. Refusing " +
        "to boot. Set ALL_PROGRAM_IDS (or PROGRAM_ID) to at least one program id.",
    );
  }

  // (2) Per-entry canonical equality — mainnet only (devnet uses its own ids).
  if (!opts.isMainnet) return;
  const offending = opts.allProgramIds.filter((id) => id !== MAINNET_PROGRAM_ID);
  if (offending.length > 0) {
    throw new Error(
      `SECURITY: NETWORK=mainnet but ALL_PROGRAM_IDS contains non-canonical ` +
        `program id(s) [${offending.join(", ")}] — expected every entry to be ` +
        `${MAINNET_PROGRAM_ID}. Refusing to boot to prevent scanning/signing ` +
        `against an unintended program.`,
    );
  }
}
