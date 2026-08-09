import { createServiceMonitors } from "@percolatorct/shared";

/**
 * BUG-110: standard health monitors (rpc/scan/oracle/db), surfaced in
 * /health's `monitors` sub-object. Factored out of index.ts so crank.ts and
 * oracle.ts can record real outcomes without a circular import on index.ts.
 * Each monitor is only as accurate as its wiring — see the recordSuccess/
 * recordFailure call sites in index.ts (rpc), crank.ts (scan, db), and
 * oracle.ts (oracle).
 */
export const monitors = createServiceMonitors("Keeper");
