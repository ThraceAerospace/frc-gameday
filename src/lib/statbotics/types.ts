export type StatboticsPrediction = {
  winner?: "red" | "blue" | null;
  red_win_prob?: number;
  red_score?: number;
  blue_score?: number;
  red_energized_rp?: number;
  blue_energized_rp?: number;
  red_supercharged_rp?: number;
  blue_supercharged_rp?: number;
  red_traversal_rp?: number;
  blue_traversal_rp?: number;
  red_rp_1?: number;
  blue_rp_1?: number;
  red_rp_2?: number;
  blue_rp_2?: number;
  red_rp_3?: number;
  blue_rp_3?: number;
};

export type StatboticsEPA = {
  epa?: number;
  auto_epa?: number;
  teleop_epa?: number;
  endgame_epa?: number;
  rp_1_epa?: number;
  rp_2_epa?: number;
  rp_3_epa?: number;
  tiebreaker_epa?: number;
  [component: `comp_${number}_epa`]: number | undefined;
};

export type StatboticsMatch = {
  key?: string;
  year?: number;
  event?: string;
  pred?: StatboticsPrediction;
  prediction?: StatboticsPrediction;
  pre_epas?: Record<string, StatboticsEPA>;
  epas?: Record<string, StatboticsEPA>;
  result?: {
    winner?: "red" | "blue" | null;
    red_score?: number;
    blue_score?: number;
    [key: string]: string | number | boolean | undefined;
  };
};

export type StatboticsMatchStatus = "loading" | "ready" | "unavailable";
