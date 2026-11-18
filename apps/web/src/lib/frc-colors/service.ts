import { frcColors } from "./index";
import type { FRCColor } from "./legacy-compatibility";

export const FRCColors = {
  getEvent: (eventCode: string, options: { refresh?: boolean } = {}): Promise<FRCColor[]> =>
    frcColors.getEvent(eventCode, options),
};
