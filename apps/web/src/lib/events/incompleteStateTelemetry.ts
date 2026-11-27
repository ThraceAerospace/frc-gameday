export type IncompleteStateEntityKind = "event" | "team";

export type IncompleteStateTelemetry = {
  entity_kind: IncompleteStateEntityKind;
  entity_key: string;
  served_source: string;
  reason_codes: string[];
  year?: number;
};

type TelemetryLogger = (message: string, payload: string) => void;

/**
 * Emit one structured observation for a page rendered without its complete
 * canonical state. This is intentionally log-only: it performs no durable
 * writes, queueing, provider requests, or retries.
 */
export function logIncompleteStateServed(
  input: IncompleteStateTelemetry,
  logger: TelemetryLogger = (message, payload) => console.info(message, payload),
  now: () => Date = () => new Date(),
): void {
  logger("[FV][IncompleteStateServed]", JSON.stringify({
    response_state: "partial",
    ...input,
    served: true,
    timestamp: now().toISOString(),
  }));
}
