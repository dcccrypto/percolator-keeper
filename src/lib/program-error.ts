/**
 * Match a Solana custom program error code exactly.
 *
 * Solana formats a custom program error as unpadded lowercase hex:
 * "custom program error: 0x4" for code 4, "0x40" for 64, "0x4c" for 76, "0x400"
 * for 1024, etc. A substring check for "custom program error: 0x4" therefore
 * also matches 0x40–0x4f and 0x400+, misreading a transient engine error in
 * those ranges as code 4. Anchoring the code with a trailing word boundary
 * (\b, since all hex digits are word characters) means only the exact code
 * matches — "0x4" hits, "0x40"/"0x4c"/"0x400" do not.
 */
export function isCustomProgramError(errMsg: string, code: number): boolean {
  const hex = code.toString(16);
  return new RegExp(`custom program error: 0x${hex}\\b`).test(errMsg);
}
