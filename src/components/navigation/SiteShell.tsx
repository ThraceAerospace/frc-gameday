"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Bars3Icon, MoonIcon, SunIcon, TvIcon, XMarkIcon } from "@heroicons/react/24/outline";

export default function SiteShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [darkMode, setDarkMode] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    setDarkMode(window.localStorage.getItem("fieldview-theme") === "dark");
  }, []);

  useEffect(() => {
    window.localStorage.setItem("fieldview-theme", darkMode ? "dark" : "light");
  }, [darkMode]);

  return (
    <div className={`site-theme ${darkMode ? "site-theme-dark" : "site-theme-light"} flex h-dvh min-h-0 w-full min-w-0 flex-col overflow-hidden bg-[var(--fv-surface)] text-[var(--fv-text)]`}>
      <header className="z-40 shrink-0 border-b border-[var(--fv-border)] bg-[var(--fv-surface-raised)]/95 backdrop-blur">
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
          <Link href="/" aria-label="FieldView home" className="flex shrink-0 items-center gap-2.5 text-xl font-extrabold tracking-tight text-[var(--fv-text)]"><svg aria-hidden="true" viewBox="0 0 40 40" className="h-8 w-8 text-[#7656C9]"><path d="M17 3h13L13 20H0L17 3Z" fill="currentColor"/><path d="M27 20h13L23 37H10l17-17Z" fill="currentColor"/><path d="M27 3h13L23 20H10L27 3Z" fill="currentColor" opacity=".72"/></svg><span>FieldView</span></Link>
          <nav aria-label="Main navigation" className="hidden shrink-0 items-center gap-1 md:flex">
            <NavLink href="/events" pathname={pathname}>Events</NavLink>
            <NavLink href="/teams" pathname={pathname}>Teams</NavLink>
            <NavLink href="/districts" pathname={pathname}>Districts</NavLink>
            <NavLink href="/insights" pathname={pathname}>Insights</NavLink>
            <NavLink href="/gameday" pathname={pathname}>Gameday</NavLink>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => setDarkMode((value) => !value)} aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"} title={darkMode ? "Switch to light mode" : "Switch to dark mode"} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">
              {darkMode ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
            </button>
            <Link href="/remote/display" className="hidden items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 sm:flex"><TvIcon className="h-4 w-4" />Remote Display</Link>
            <Link href="/remote" className="rounded-lg bg-[#7656C9] px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#5D3FB1]">Remote Controller</Link>
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

function NavLink({ href, pathname, children }: { href: string; pathname: string; children: React.ReactNode }) {
  const active = pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  return <Link href={href} aria-current={active ? "page" : undefined} className={["relative rounded-lg px-3 py-2 text-sm font-semibold transition-colors", active ? "bg-[var(--fv-brand-soft)] text-[var(--fv-brand)]" : "text-[var(--fv-muted)] hover:bg-[var(--fv-brand-soft)] hover:text-[var(--fv-text)]"].join(" ")}>{children}{active && <span aria-hidden="true" className="absolute inset-x-3 -bottom-1 h-0.5 rounded-full bg-[var(--fv-brand)]" />}</Link>;
}

function MobileNavLink({ href, onNavigate, children }: { href: string; onNavigate: () => void; children: React.ReactNode }) {
  return <Link href={href} onClick={onNavigate} className="rounded-lg px-3 py-3 text-sm font-semibold text-[var(--fv-text)] hover:bg-[var(--fv-brand-soft)]">{children}</Link>;
}
