import Link from "next/link";
import SiteShell from "@/components/navigation/SiteShell";
import { TBA } from "@/lib/tba/service";

// TBAClient uses Redis for upstream caching and fetches with cache: "no-store".
// Keep this route dynamically rendered so Next.js does not try to ISR-cache it.
export const dynamic = "force-dynamic";

export default async function DistrictsPage() {
  const year = new Date().getFullYear();
  const districts = await TBA.getDistricts(year);
  return (
    <SiteShell>
      <div className="mx-auto max-w-6xl px-5 py-8 lg:px-8 lg:py-10">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#7656C9]">FIRST Robotics Competition</p>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-slate-950">{year} Districts</h1>
        <p className="mt-2 text-sm text-slate-500">Explore the active districts for the {year} season.</p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {districts.map((district) => (
            <Link key={district.key} href={`/district/${district.abbreviation.toLowerCase()}`} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-blue-200 hover:bg-[#F1EDFA]/40">
              <p className="font-mono text-xs text-slate-400">{district.key}</p>
              <h2 className="mt-1 text-lg font-bold text-slate-900">{district.display_name}</h2>
              <p className="mt-3 text-xs font-semibold text-[#7656C9]">View district →</p>
            </Link>
          ))}
        </div>
        {!districts.length && <p className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">No active districts are listed for {year}.</p>}
      </div>
    </SiteShell>
  );
}
