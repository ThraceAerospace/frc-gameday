/**
 * Canonical FieldView identifiers.
 *
 * Identifier values intentionally retain the established TBA key format.
 * They are opaque outside the provider boundary: consumers should compare
 * and persist them, not parse their internal structure.
 */
type OpaqueString<Name extends string> = string & { readonly __fieldViewIdentifier: Name };

export type TeamKey = OpaqueString<"TeamKey">;
export type EventKey = OpaqueString<"EventKey">;
export type MatchKey = OpaqueString<"MatchKey">;

/**
 * Mark a validated TBA key as a canonical FieldView identifier.
 *
 * Validation belongs at the TBA adapter boundary. These casts do not perform
 * runtime validation.
 */
export const teamKeyFromTba = (value: string): TeamKey => value as TeamKey;
export const eventKeyFromTba = (value: string): EventKey => value as EventKey;
export const matchKeyFromTba = (value: string): MatchKey => value as MatchKey;
