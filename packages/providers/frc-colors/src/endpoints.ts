/** Provider-relative FRC Colors v1 resource paths. */
export const FRC_COLORS_ENDPOINTS = {
  team: (teamNumber: number) => "/team/" + encodeURIComponent(String(teamNumber)),
  event: (eventCode: string) => "/event/" + encodeURIComponent(eventCode),
} as const;
