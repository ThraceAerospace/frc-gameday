import type { TileSurfaceState } from "@/components/surface/TileSurfaceState";

/**
 * Resolve the single event a Surface's supplementary Insights display follows.
 * Tile identity is intentionally resolved before event identity.
 */
export function resolveActiveEventKey(state: Pick<
  TileSurfaceState,
  "activeKey" | "priority" | "tileEvents"
>): string | null {
  const activeTileId =
    state.activeKey && state.priority.includes(state.activeKey)
      ? state.activeKey
      : state.priority[0] ?? null;

  if (!activeTileId) return null;
  return state.tileEvents[activeTileId] ?? activeTileId;
}
