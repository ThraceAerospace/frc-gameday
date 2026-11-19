import type {
  FieldViewAnalyticsAudit,
  FieldViewAnalyticsInputRecord,
} from "../../../domain/src/analytics.ts";
import { getAnalyticsDefinition } from "./definitions.ts";

export const FIELDVIEW_ANALYTICS_ENGINE_VERSION = "0.1.0";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export interface CreateAnalyticsAuditInput {
  calculation_id: string;
  calculated_at: number;
  inputs: FieldViewAnalyticsInputRecord[];
  definition_keys: string[];
  warnings?: string[];
}

/**
 * Creates a reproducible audit envelope. The digest covers the normalized
 * input manifest, not provider credentials or transport headers.
 */
export async function createAnalyticsAudit(
  input: CreateAnalyticsAuditInput,
): Promise<FieldViewAnalyticsAudit> {
  const inputs = [...input.inputs].sort((a, b) => a.input_key.localeCompare(b.input_key));
  const manifest = JSON.stringify(stableValue(inputs));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifest));
  const definition_versions = [...new Set(input.definition_keys)]
    .map((definition_key) => {
      const definition = getAnalyticsDefinition(definition_key);
      if (!definition) throw new Error(`Unknown analytics definition: ${definition_key}`);
      return { definition_key, version: definition.version };
    })
    .sort((a, b) => a.definition_key.localeCompare(b.definition_key));

  return {
    calculation_id: input.calculation_id,
    engine_version: FIELDVIEW_ANALYTICS_ENGINE_VERSION,
    calculated_at: input.calculated_at,
    input_digest: toHex(digest),
    inputs,
    definition_versions,
    warnings: [...(input.warnings ?? [])],
  };
}
