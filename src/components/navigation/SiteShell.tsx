"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bars3Icon, MoonIcon, SunIcon, TvIcon, XMarkIcon } from "@heroicons/react/24/outline";

export default function SiteShell({ children }: { children: React.ReactNode }) {
  const [darkMode, setDarkMode] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    setDarkMode(window.localStorage.getItem("fieldview-theme") === "dark");
  }, []);

  useEffect(() => {
    window.localStorage.setItem("fieldview-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  return (
    <div className={`site-theme ${darkMode ? "site-theme-dark" : "site-theme-light"} flex h-dvh min-h-0 w-full min-w-0 flex-col overflow-hidden bg-slate-50 text-slate-900`}>
      <header className="z-40 shrink-0 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-[1600px] min-w-0 items-center gap-3 px-4 lg:px-6">
          <button
            type="button"
            aria-label={mobileMenuOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-controls="mobile-navigation"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((open) => !open)}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-600 md:hidden"
          >
            {mobileMenuOpen ? <XMarkIcon className="h-5 w-5" /> : <Bars3Icon className="h-5 w-5" />}
          </button>
          <Link href="/" className="shrink-0 text-xl font-black tracking-tight text-slate-900">Field<span className="text-blue-600">View</span></Link>
          <nav aria-label="Main navigation" className="hidden shrink-0 items-center gap-1 md:flex">
            <NavLink href="/events">Events</NavLink>
            <NavLink href="/teams">Teams</NavLink>
            <NavLink href="/districts">Districts</NavLink>
            <NavLink href="/insights">Insights</NavLink>
            <NavLink href="/gameday">Gameday</NavLink>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => setDarkMode((value) => !value)} aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"} title={darkMode ? "Switch to light mode" : "Switch to dark mode"} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">
              {darkMode ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
            </button>
            <Link href="/remote/display" className="hidden items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 sm:flex"><TvIcon className="h-4 w-4" />Remote Display</Link>
            <Link href="/remote" className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white">Remote Controller</Link>
          </div>
        </div>

        {mobileMenuOpen && (
          <nav id="mobile-navigation" aria-label="Mobile navigation" className="border-t border-slate-200 bg-white px-4 py-3 md:hidden">
            <div className="mx-auto grid max-w-[1600px] grid-cols-2 gap-1">
              <MobileNavLink href="/" onNavigate={() => setMobileMenuOpen(false)}>Events</MobileNavLink>
              <MobileNavLink href="/teams" onNavigate={() => setMobileMenuOpen(false)}>Teams</MobileNavLink>
              <MobileNavLink href="/districts" onNavigate={() => setMobileMenuOpen(false)}>Districts</MobileNavLink>
              <MobileNavLink href="/insights" onNavigate={() => setMobileMenuOpen(false)}>Insights</MobileNavLink>
              <MobileNavLink href="/gameday" onNavigate={() => setMobileMenuOpen(false)}>Gameday</MobileNavLink>
              <MobileNavLink href="/remote/display" onNavigate={() => setMobileMenuOpen(false)}>Remote Display</MobileNavLink>
            </div>
          </nav>
        )}
      </header>

      <main data-scroll-container className="mx-auto min-h-0 w-full max-w-[1600px] min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</main>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">{children}</Link>;
}

function MobileNavLink({ href, onNavigate, children }: { href: string; onNavigate: () => void; children: React.ReactNode }) {
  return <Link href={href} onClick={onNavigate} className="rounded-lg px-3 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">{children}</Link>;
}
