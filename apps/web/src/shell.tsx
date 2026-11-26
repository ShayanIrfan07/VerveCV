import { useId, useState, type ReactNode } from "react";

export type WorkspaceSection = "dashboard" | "analyze" | "history" | "pricing" | "settings";

const WORKSPACE_LINKS: Array<{ id: WorkspaceSection; label: string; group: "Workspace" | "Account" }> = [
  { id: "dashboard", label: "Dashboard", group: "Workspace" },
  { id: "analyze", label: "New analysis", group: "Workspace" },
  { id: "history", label: "My resumes", group: "Workspace" },
  { id: "pricing", label: "Subscription", group: "Account" },
  { id: "settings", label: "Settings", group: "Account" },
];

export function Brand() {
  return (
    <span className="inline-flex items-center gap-2 text-2xl font-bold text-primary">
      <Mark />
      VerveCV
    </span>
  );
}

export function MarketingHeader({
  onAccount,
  onHome,
  onPricing,
}: {
  onAccount: () => void;
  onHome: () => void;
  onPricing: () => void;
}) {
  return (
    <header className="border-b border-line bg-card">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <button className="rounded-lg" onClick={onHome} type="button">
          <Brand />
        </button>
        <nav aria-label="Site" className="flex flex-wrap items-center gap-3 text-sm text-body">
          <a className="rounded-lg px-2 py-2" href="#features">
            Features
          </a>
          <a className="rounded-lg px-2 py-2" href="#how-it-works">
            How it works
          </a>
          <button className="rounded-lg px-2 py-2" onClick={onPricing} type="button">
            Pricing
          </button>
          <button className={navButton} onClick={onAccount} type="button">
            Sign in
          </button>
        </nav>
      </div>
    </header>
  );
}

export function AppShell({
  section,
  onSection,
  account,
  children,
}: {
  section: WorkspaceSection;
  onSection: (section: WorkspaceSection) => void;
  account: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const navId = useId();
  const choose = (next: WorkspaceSection) => {
    setOpen(false);
    onSection(next);
  };

  return (
    <div className="min-h-screen bg-canvas lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="border-b border-line bg-card lg:min-h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-4 py-4 lg:px-5">
          <Brand />
          <button
            aria-controls={navId}
            aria-expanded={open}
            className="inline-flex min-h-11 items-center rounded-[10px] border border-line px-3 text-sm font-semibold text-body lg:hidden"
            onClick={() => setOpen((current) => !current)}
            type="button"
          >
            {open ? "Close menu" : "Menu"}
          </button>
        </div>
        <nav
          aria-label="Workspace"
          className={`${open ? "block" : "hidden"} px-3 pb-4 lg:block`}
          id={navId}
        >
          {(["Workspace", "Account"] as const).map((group) => (
            <div key={group}>
              <p className="px-3 pt-3 text-xs font-semibold tracking-wide text-muted">{group}</p>
              {WORKSPACE_LINKS.filter((link) => link.group === group).map((link) => (
                <button
                  className={`mt-1 flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm ${
                    section === link.id ? "bg-primary-muted font-semibold text-primary-bright" : "text-muted"
                  }`}
                  key={link.id}
                  onClick={() => choose(link.id)}
                  type="button"
                >
                  {link.label}
                </button>
              ))}
            </div>
          ))}
          <div className="mt-4 rounded-xl bg-hero p-4 text-sm text-[#21143D]">
            <p className="font-semibold">Free plan</p>
            <p className="mt-1 text-[#6B5C85]">Pricing and quotas are not approved yet.</p>
            <button className="mt-3 font-semibold text-primary" onClick={() => choose("pricing")} type="button">
              View plans
            </button>
          </div>
          <div className="mt-4">{account}</div>
        </nav>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function PageHeader({ eyebrow, title, detail }: { eyebrow?: string; title: string; detail?: string }) {
  return (
    <header className="mb-6">
      {eyebrow ? <p className="text-sm text-muted">{eyebrow}</p> : null}
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">{title}</h1>
      {detail ? <p className="mt-3 max-w-2xl text-base leading-7 text-body">{detail}</p> : null}
    </header>
  );
}

function Mark() {
  return (
    <svg aria-hidden="true" className="h-6 w-6" fill="none" viewBox="0 0 24 24">
      <rect height="14" rx="2" stroke="currentColor" strokeWidth="1.8" width="14" x="5" y="5" />
      <path d="M8 10h8M8 14h5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

const navButton =
  "inline-flex min-h-11 items-center justify-center rounded-[10px] bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-bright";
