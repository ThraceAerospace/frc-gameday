"use client";

import { useRouter } from "next/navigation";

export default function TeamSeasonSelector({
  years,
  selectedYear,
}: {
  years: number[];
  selectedYear: number;
}) {
  const router = useRouter();

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="font-semibold text-slate-500">Season</span>
      <select
        value={selectedYear}
        onChange={(event) => {
          router.push(`?year=${event.target.value}`);
        }}
        className="rounded-lg border border-slate-200 bg-white px-3 py-2 font-semibold text-slate-800 outline-none focus:border-blue-400"
      >
        {years.map((year) => (
          <option key={year} value={year}>
            {year}
          </option>
        ))}
      </select>
    </label>
  );
}
