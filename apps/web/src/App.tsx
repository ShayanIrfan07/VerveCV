import { useCallback, useEffect, useState } from "react";
import { apiRequest, type SessionUser } from "./api";
import { AuthPanel } from "./auth-panel";
import { AppShell, PageHeader, type WorkspaceSection } from "./shell";
import { UploadPanel } from "./upload-panel";
import { card, primaryButton } from "./ui";

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sessionState, setSessionState] = useState<"checking" | "anonymous" | "unavailable">("checking");
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [section, setSection] = useState<WorkspaceSection>("dashboard");
  const [resultsActive, setResultsActive] = useState(false);
  const reportResults = useCallback((active: boolean) => {
    setResultsActive(active);
  }, []);
  const workspace = section === "dashboard" || section === "analyze" || section === "history";

  useEffect(() => {
    let cancelled = false;
    void apiRequest<{ user: SessionUser }>("/api/v1/me")
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.status === 200 && result.body?.user) {
          setUser(result.body.user);
          setSessionState("anonymous");
          return;
        }
        setUser(null);
        setSessionState(result.status === 401 ? "anonymous" : "unavailable");
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setSessionState("unavailable");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionAttempt]);

  useEffect(() => {
    setSection("dashboard");
    setResultsActive(false);
  }, [user?.id]);

  if (user) {
    return (
      <AppShell
        account={<AuthPanel compact onUser={setUser} user={user} />}
        onSection={setSection}
        section={section}
        sidebar={!resultsActive || !workspace}
      >
        <main className={resultsActive && workspace ? "w-full min-w-0" : "w-full min-w-0 px-4 py-6 sm:px-6"}>
          {section === "pricing" ? <Pricing signedIn /> : null}
          {section === "settings" ? <Settings user={user} /> : null}
          <div className={section === "dashboard" || section === "analyze" || section === "history" ? "" : "hidden"}>
            <UploadPanel
              key={user.id}
              focus={section === "pricing" || section === "settings" ? "dashboard" : section}
              onEvaluationActive={reportResults}
              onNewAnalysis={() => setSection("analyze")}
              onSessionExpired={() => setUser(null)}
              user={user}
            />
          </div>
        </main>
      </AppShell>
    );
  }

  if (sessionState === "checking") {
    return (
      <div className="grid min-h-screen place-items-center bg-[#FAF8FF] text-[#64748B]">
        <p role="status">Checking your session</p>
      </div>
    );
  }

  if (sessionState === "unavailable") {
    return (
      <div className="grid min-h-screen place-items-center bg-[#FAF8FF] px-4 text-center text-[#17172B]">
        <div>
          <h1 className="text-2xl font-semibold">VerveCV could not reach your account</h1>
          <p className="mt-2 text-[#64748B]">The session service did not respond. Your resumes were not loaded.</p>
          <button
            className={`${primaryButton} mt-6`}
            onClick={() => {
              setSessionState("checking");
              setSessionAttempt((attempt) => attempt + 1);
            }}
            type="button"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return <AccountView onUser={setUser} />;
}
function AccountView({ onUser }: { onUser: (user: SessionUser | null) => void }) {
  return (
    <div className="auth-stage">
      <div aria-hidden="true" className="auth-stage__glow left-[-8rem] top-[-6rem] h-80 w-80 bg-[#C4B5FD]" />
      <div aria-hidden="true" className="auth-stage__glow right-[-6rem] top-10 h-72 w-72 bg-[#BFDBFE]" />
      <div aria-hidden="true" className="auth-stage__glow bottom-[-5rem] left-1/3 h-72 w-72 bg-[#FBCFE8]" />
      <div aria-hidden="true" className="auth-stage__glow right-1/4 bottom-16 h-56 w-56 bg-[#A78BFA]" />
      <svg aria-hidden="true" className="pointer-events-none absolute right-8 top-8 h-24 w-24 text-[#C4B5FD] opacity-70" viewBox="0 0 100 100">
        <circle cx="50" cy="50" fill="none" r="36" stroke="currentColor" strokeWidth="8" />
      </svg>
      <main className="relative z-10 grid min-h-screen place-items-center px-4 py-10">
        <section className="auth-card text-[#17172B]">
          <p className="text-2xl font-bold text-[#7C3AED]">VerveCV</p>
          <h1 className="mt-6 text-3xl font-semibold text-[#17172B]">Welcome back</h1>
          <p className="mt-2 text-[#64748B]">Sign in, or create an account from this form.</p>
          <div className="mt-6">
            <AuthPanel onUser={onUser} user={null} />
          </div>
        </section>
      </main>
    </div>
  );
}

function Pricing({ signedIn, onAccount }: { signedIn: boolean; onAccount?: () => void }) {
  return (
    <section className={signedIn ? "space-y-6" : card} id="pricing">
      {signedIn ? <PageHeader detail="Pro checkout is not available." title="Plans" /> : null}
      {!signedIn ? <h2 className="text-2xl font-semibold text-ink">Plans</h2> : null}
      <p className="mt-2 text-body">Free is the only plan. This page does not start a payment.</p>
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <article className={card}>
          <h3 className="text-2xl font-semibold text-ink">Free</h3>
          <p className="mt-2">Your account can upload and score resumes.</p>
          {signedIn ? null : (
            <button className={`${primaryButton} mt-5`} onClick={onAccount} type="button">
              Get started
            </button>
          )}
        </article>
        <article className="rounded-xl border-2 border-primary bg-card p-6">
          <p className="inline-flex rounded-md bg-primary-muted px-2 py-1 text-sm font-semibold text-primary-bright">Pro</p>
          <h3 className="mt-3 text-2xl font-semibold text-ink">Not available</h3>
          <p className="mt-2">Pro is not available.</p>
        </article>
      </div>
    </section>
  );
}

function Settings({ user }: { user: SessionUser }) {
  return (
    <section className="space-y-5">
      <PageHeader detail="Account details come from your session. Profile editing is not available." title="Settings" />
      <article className={card}>
        <h2 className="text-xl font-semibold text-ink">Profile information</h2>
        <dl className="mt-4 grid gap-4">
          <div>
            <dt className="text-sm text-muted">Name</dt>
            <dd className="mt-1 text-ink">{user.displayName ?? "No display name is saved."}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Email address</dt>
            <dd className="mt-1 break-all text-ink">{user.email}</dd>
          </div>
        </dl>
      </article>
      <article className={card}>
        <h2 className="text-xl font-semibold text-ink">Privacy and data</h2>
        <p className="mt-2">Verified resumes are kept for 90 days.</p>
      </article>
      <article className={card}>
        <h2 className="text-xl font-semibold text-ink">Appearance</h2>
        <p className="mt-3 inline-flex rounded-md bg-primary-muted px-2 py-1 text-sm font-semibold text-primary-bright">Light mode</p>
      </article>
    </section>
  );
}
