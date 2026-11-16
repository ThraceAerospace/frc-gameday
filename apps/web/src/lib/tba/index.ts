import { TBAClient } from "./client";

export const tba = new TBAClient(process.env.TBA_API_KEY!);