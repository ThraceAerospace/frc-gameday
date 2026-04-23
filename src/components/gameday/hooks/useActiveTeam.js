"use client";

import { useMemo, useState, useEffect } from "react";

export function useActiveTeam(initialTeam, teams = []) {
  const [activeTeam, setActiveTeam] = useState(initialTeam || null);

  // keep in sync if parent changes
  useEffect(() => {
    setActiveTeam(initialTeam || null);
  }, [initialTeam]);

  // resolve full team object
  const activeTeamData = useMemo(() => {
    if (!activeTeam || !teams?.length) return null;
    return teams.find(t => t.key === activeTeam) || null;
  }, [activeTeam, teams]);

  // derived stats (safe fallback layer)
  const activeTeamStatus = useMemo(() => {
    return activeTeamData?.status ?? null;
  }, [activeTeamData]);

  const activeTeamRank = useMemo(() => {
    return activeTeamData?.rank ?? null;
  }, [activeTeamData]);

  const activeTeamRecord = useMemo(() => {
    return activeTeamData?.record ?? null;
  }, [activeTeamData]);

  return {
    activeTeam,
    setActiveTeam,

    activeTeamData,
    activeTeamStatus,
    activeTeamRank,
    activeTeamRecord,
  };
}