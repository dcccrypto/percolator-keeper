/**
 * Input validation utilities for CLI commands.
 * Provides descriptive error messages for invalid input.
 */
import { PublicKey } from "@solana/web3.js";
export declare class ValidationError extends Error {
    readonly field: string;
    constructor(field: string, message: string);
}
/**
 * Validate a public key string.
 *
 * @param value - Base58-encoded public key string.
 * @param field - Field name for error messages.
 * @returns Parsed `PublicKey` instance.
 * @throws {@link ValidationError} if the string is not a valid base58 public key.
 *
 * @example
 * ```ts
 * const key = validatePublicKey("11111111111111111111111111111111", "slab");
 * ```
 */
export declare function validatePublicKey(value: string, field: string): PublicKey;
/**
 * Validate a non-negative integer index (u16 range for accounts).
 *
 * @param value - Decimal string representing the index.
 * @param field - Field name for error messages.
 * @returns Parsed integer in `[0, 65535]`.
 * @throws {@link ValidationError} if the value is not a valid u16 integer.
 */
export declare function validateIndex(value: string, field: string): number;
/**
 * Validate a non-negative amount (u64 range).
 *
 * @param value - Decimal string representing the amount.
 * @param field - Field name for error messages.
 * @returns Parsed `bigint` in `[0, 2^64 - 1]`.
 * @throws {@link ValidationError} if the value is negative or exceeds u64 max.
 */
export declare function validateAmount(value: string, field: string): bigint;
/**
 * Validate a u128 value.
 */
export declare function validateU128(value: string, field: string): bigint;
/**
 * Validate an i64 value.
 */
export declare function validateI64(value: string, field: string): bigint;
/**
 * Validate an i128 value (trade sizes).
 */
export declare function validateI128(value: string, field: string): bigint;
/**
 * Validate a basis points value (0–10000).
 *
 * @param value - Decimal string representing basis points.
 * @param field - Field name for error messages.
 * @returns Parsed integer in `[0, 10000]`.
 * @throws {@link ValidationError} if the value exceeds 10000.
 */
export declare function validateBps(value: string, field: string): number;
/**
 * Validate a u64 value.
 */
export declare function validateU64(value: string, field: string): bigint;
/**
 * Validate a u16 value.
 */
export declare function validateU16(value: string, field: string): number;
