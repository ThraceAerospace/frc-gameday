"use client";

import { useState } from "react";

export function useActiveTeam(initialTeam: Object) {
  const [activeTeam, setActiveTeam] = useState(initialTeam);

  return {
    activeTeam,
    setActiveTeam,
  };
}