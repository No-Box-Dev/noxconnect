import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, BarChart3, ChevronDown, LogOut, Search, Settings } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useIsAdmin, useMe, useRateLimit, useUnacknowledgedRepos } from "@/hooks/useGitHub";
import { getDefaultEnabledTab, type NoxAppId } from "@/lib/apps";
import { cn } from "@/lib/cn";
import { useOptionalProject } from "@/lib/project";
import type { TabId } from "@/lib/types";

const ALL_APP_IDS: readonly NoxAppId[] = ["noxconnect", "noxticket", "noxfeed", "noxspot", "noxcue"];

const NAV_ITEMS: readonly { id: TabId; label: string; appId: NoxAppId }[] = [
  { id: "current", label: "Current", appId: "noxfeed" },
  { id: "sprint", label: "Features", appId: "noxticket" },
  { id: "specs", label: "Specs", appId: "noxticket" },
  { id: "posts", label: "Feed", appId: "noxfeed" },
  { id: "issues", label: "Issues", appId: "noxfeed" },
];

interface TopNavProps {
  activeTab: TabId;
  pendingTab?: TabId | null;
  onTabChange: (tab: TabId) => void;
  onTabIntent?: (tab: TabId) => void;
  enabledApps?: readonly NoxAppId[];
}

export function TopNav({ activeTab, pendingTab, onTabChange, onTabIntent, enabledApps = ALL_APP_IDS }: TopNavProps) {
  const { user, setSelectedOrg, logout } = useAuth();
  const projectContext = useOptionalProject();
  const { data: rateLimit } = useRateLimit();
  const isRateLimited = rateLimit && rateLimit.remaining < rateLimit.limit * 0.2;
  const isAdmin = useIsAdmin();
  const me = useMe();
  const unacked = useUnacknowledgedRepos();
  const newRepoCount = isAdmin ? unacked.length : 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  const navItems = NAV_ITEMS.filter((item) => enabledApps.includes(item.appId));

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    mobileNavRef.current?.querySelector<HTMLElement>("[aria-current='page']")?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTab]);

  return (
    <header className="sticky top-0 z-30 shrink-0 border-b border-stone-200 bg-white">
      <div className="relative flex h-14 items-center justify-between gap-4 px-4 sm:px-6">
        <button
          type="button"
          onClick={() => onTabChange(getDefaultEnabledTab(enabledApps))}
          className="shrink-0 cursor-pointer font-display text-base tracking-tight text-stone-800"
          aria-label="Nox home"
        >
          <span className="font-bold">Nox</span>
        </button>

        <nav aria-label="Main views" aria-busy={pendingTab ? true : undefined} className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-1 md:flex">
          {navItems.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onPointerEnter={() => onTabIntent?.(id)}
              onPointerDown={() => onTabIntent?.(id)}
              onFocus={() => onTabIntent?.(id)}
              onClick={() => onTabChange(id)}
              aria-current={activeTab === id ? "page" : undefined}
              className={cn(
                "relative cursor-pointer px-3 py-2 text-sm font-medium transition-colors",
                activeTab === id ? "text-stone-900" : "text-stone-500 hover:text-stone-800",
              )}
            >
              {label}
              {activeTab === id ? <span className="absolute -bottom-[1px] left-3 right-3 h-[2px] rounded-full bg-accent" /> : null}
              {pendingTab === id ? <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : null}
            </button>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {projectContext ? <label className="hidden items-center sm:flex">
            <span className="sr-only">Active project</span>
            <select
              aria-label="Active project"
              value={projectContext.project.id}
              onChange={(event) => projectContext.setProjectId(event.target.value)}
              className="max-w-40 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-600"
            >
              {projectContext.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label> : null}
          <button
            type="button"
            onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-stone-200 px-2.5 py-1.5 text-stone-400 transition-colors hover:bg-stone-50"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden text-xs sm:inline">Search</span>
            <kbd className="hidden rounded border border-stone-200 bg-stone-100 px-1 py-0.5 font-mono text-[10px] sm:inline-flex">⌘K</kbd>
          </button>

          {isRateLimited ? (
            <div className="h-2 w-2 shrink-0 rounded-full bg-severity-mid" title={`GitHub API: ${rateLimit.remaining}/${rateLimit.limit} remaining`} />
          ) : null}

          <button
            type="button"
            onPointerEnter={() => onTabIntent?.("admin")}
            onPointerDown={() => onTabIntent?.("admin")}
            onFocus={() => onTabIntent?.("admin")}
            onClick={() => onTabChange("admin")}
            className={cn(
              "relative cursor-pointer rounded-lg p-1.5 transition-colors",
              activeTab === "admin" ? "bg-accent/10 text-accent" : "text-stone-400 hover:bg-stone-100 hover:text-stone-600",
            )}
            title={newRepoCount > 0 ? `${newRepoCount} new repo${newRepoCount === 1 ? "" : "s"} detected — review in Admin` : "Admin"}
          >
            <Settings className="h-4 w-4" />
            {newRepoCount > 0 ? <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-white" /> : null}
          </button>

          <div className="relative" ref={menuRef}>
            <button type="button" onClick={() => setMenuOpen((open) => !open)} className="flex cursor-pointer items-center gap-1.5 rounded-lg py-1 pl-1 pr-1.5 transition-colors hover:bg-stone-50">
              {user ? <img src={user.avatar_url} alt={user.login} className="h-7 w-7 shrink-0 rounded-full" /> : null}
              <ChevronDown className="h-3 w-3 shrink-0 text-stone-400" />
            </button>

            {menuOpen ? (
              <div className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded-lg border border-stone-200 bg-white py-1 shadow-md">
                <div className="border-b border-stone-100 px-3 py-2">
                  <div className="truncate text-sm text-stone-700">{user?.name ?? user?.login}</div>
                  {user?.name ? <div className="truncate text-xs text-stone-400">@{user.login}</div> : null}
                </div>
                {me.data?.isPlatformOperator ? (
                  <a href="/operator" onClick={() => setMenuOpen(false)} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm text-stone-600 hover:bg-stone-50">
                    <BarChart3 className="h-4 w-4" /> Business overview
                  </a>
                ) : null}
                <button type="button" onClick={() => { setSelectedOrg(null); setMenuOpen(false); }} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm text-stone-600 hover:bg-stone-50">
                  <ArrowLeftRight className="h-4 w-4" /> Switch Organisation
                </button>
                <div className="my-1 border-t border-stone-100" />
                <button type="button" onClick={() => { logout(); setMenuOpen(false); }} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-sm text-stone-500 hover:bg-stone-50 hover:text-severity-high">
                  <LogOut className="h-4 w-4" /> Sign Out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {pendingTab ? <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-accent/10"><div className="h-full w-1/3 animate-navigation-progress bg-accent" /></div> : null}

      <nav ref={mobileNavRef} aria-label="Mobile views" aria-busy={pendingTab ? true : undefined} className="flex items-center gap-1 overflow-x-auto px-2 pb-1.5 md:hidden">
        {navItems.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onPointerDown={() => onTabIntent?.(id)}
            onFocus={() => onTabIntent?.(id)}
            onClick={() => onTabChange(id)}
            aria-current={activeTab === id ? "page" : undefined}
            className={cn(
              "cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium",
              activeTab === id ? "bg-accent/10 text-accent" : "text-stone-500 hover:bg-stone-50",
            )}
          >
            {label}
          </button>
        ))}
      </nav>
    </header>
  );
}
