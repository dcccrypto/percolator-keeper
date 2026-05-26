/**
 * Percolator program error definitions.
 * Each error includes a name and actionable guidance.
 */
interface ErrorInfo {
    name: string;
    hint: string;
}
export declare const PERCOLATOR_ERRORS: Record<number, ErrorInfo>;
/**
 * Decode a custom program error code to its info.
 */
export declare function decodeError(code: number): ErrorInfo | undefined;
/**
 * Get error name from code.
 */
export declare function getErrorName(code: number): string;
/**
 * Get actionable hint for error code.
 */
export declare function getErrorHint(code: number): string | undefined;
/**
 * Check whether an error code is in the Anchor framework error range
 * (used by Lighthouse, not Percolator).
 */
export declare function isAnchorErrorCode(code: number): boolean;
/**
 * Parse error from transaction logs.
 * Looks for "Program ... failed: custom program error: 0x..."
 *
 * Hex capture is bounded (1–8 digits) so pathological logs cannot feed unbounded
 * strings into `parseInt` or produce precision-loss codes above u32.
 *
 * Distinguishes between:
 * - Percolator program errors (codes 0–65): returns Percolator error info
 * - Anchor/Lighthouse errors (codes 0x1770–0x1FFF): returns Lighthouse-specific
 *   name and hint so callers can handle wallet middleware failures
 */
export declare function parseErrorFromLogs(logs: string[]): {
    code: number;
    name: string;
    hint?: string;
    source?: "percolator" | "lighthouse" | "unknown";
} | null;
export {};
