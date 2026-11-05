"use client";

import { useEffect, useState } from "react";
import { formatEventDateRange } from "@/lib/time";

export default function EventDateRange({
  startDate,
  endDate,
}: {
  startDate: string;
  endDate: string;
}) {
  const [locale, setLocale] = useState("en-US");

  useEffect(() => {
    setLocale(navigator.language || "en-US");
  }, []);

  return <>{formatEventDateRange(startDate, endDate, locale)}</>;
}
