export type StatboticsPrediction = Record<string, unknown>;

export type StatboticsMatch = {
  key?: string;
  pred?: StatboticsPrediction;
  prediction?: StatboticsPrediction;
  pre_epas?: Record<string, unknown>;
  [key: string]: unknown;
};

export type StatboticsMatchStatus = "loading" | "ready" | "unavailable";
