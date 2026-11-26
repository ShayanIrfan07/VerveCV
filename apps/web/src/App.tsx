import { useCallback, useEffect, useState } from "react";
import { apiRequest, type SessionUser } from "./api";
import { AuthPanel } from "./auth-panel";
import { AppShell, MarketingHeader, PageHeader, type WorkspaceSection } from "./shell";
import { UploadPanel } from "./upload-panel";
import { card, primaryButton, secondaryButton } from "./ui";

type PublicView = "home" | "account" | "pricing";

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [publicView, setPublicView] = useState<PublicView>("home");
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
        if (!cancelled && result.status === 200 && result.body?.user) {
          setUser(result.body.user);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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
              focus={section === "pricing" || section === "settings" ? "dashboard" : section}
              onEvaluationActive={reportResults}
              onNewAnalysis={() => setSection("analyze")}
              user={user}
            />
          </div>
        </main>
      </AppShell>
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-body">
      <MarketingHeader
        onAccount={() => setPublicView("account")}
        onHome={() => setPublicView("home")}
        onPricing={() => setPublicView("pricing")}
      />
      <main>
        {publicView === "account" ? <AccountView onUser={setUser} /> : null}
        {publicView === "pricing" ? (
          <div className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8">
            <Pricing signedIn={false} onAccount={() => setPublicView("account")} />
          </div>
        ) : null}
        {publicView === "home" ? <Landing onAccount={() => setPublicView("account")} onPricing={() => setPublicView("pricing")} /> : null}
      </main>
    </div>
  );
}

function Landing({ onAccount, onPricing }: { onAccount: () => void; onPricing: () => void }) {
  return (
    <div className="mx-auto max-w-[1280px] space-y-8 px-4 py-8 sm:px-6 lg:px-8">
      <section className="px-2 py-8 text-center sm:py-12">
        <p className="inline-flex rounded-md bg-primary-muted px-3 py-1 text-sm font-semibold text-primary-bright">
          Your next career move starts here
        </p>
        <h1 className="mx-auto mt-6 max-w-4xl text-4xl font-semibold tracking-tight text-ink sm:text-6xl">
          Great careers start with <span className="text-primary">great resumes.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-body">
          Understand your resume’s strengths, uncover opportunities, and apply with confidence.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button className={primaryButton} onClick={onAccount} type="button">
            Analyze my resume
          </button>
          <a className={secondaryButton} href="#how-it-works">
            How it works
          </a>
        </div>
        <p className="mt-4 text-sm text-muted">Free to get started · PDF and DOCX supported</p>
      </section>

      <section className="rounded-2xl bg-hero p-4 text-[#6B5C85] sm:p-6">
        <UploadPanel user={null} />
      </section>

      <section className="grid gap-5 md:grid-cols-3" id="features">
        <article className={card}>
          <h2 className="text-lg font-semibold text-primary">Resume insights</h2>
          <p className="mt-2">See the checks the server can already score.</p>
        </article>
        <article className={card}>
          <h2 className="text-lg font-semibold text-good">Actionable feedback</h2>
          <p className="mt-2">Review only findings returned for your file.</p>
        </article>
        <article className={card}>
          <h2 className="text-lg font-semibold text-info">Private and secure</h2>
          <p className="mt-2">Files stay in your account and follow the 90-day retention period.</p>
        </article>
      </section>

      <section id="how-it-works">
        <h2 className="text-2xl font-semibold text-ink">How VerveCV works</h2>
        <div className="mt-4 grid gap-5 md:grid-cols-3">
          <article className={card}>
            <p className="text-sm font-semibold text-primary">01</p>
            <h3 className="mt-2 text-lg font-semibold text-ink">Upload</h3>
            <p className="mt-2">Choose a PDF or DOCX. The browser reads a preview, then the server verifies the stored file.</p>
          </article>
          <article className={card}>
            <p className="text-sm font-semibold text-primary">02</p>
            <h3 className="mt-2 text-lg font-semibold text-ink">Evaluate</h3>
            <p className="mt-2">The server returns the checks that are ready. A partial result is not shown as a score out of 100.</p>
          </article>
          <article className={card}>
            <p className="text-sm font-semibold text-primary">03</p>
            <h3 className="mt-2 text-lg font-semibold text-ink">Improve</h3>
            <p className="mt-2">Use the findings that belong to your resume. Unavailable checks stay unexplained until they are approved.</p>
          </article>
        </div>
      </section>

      <section aria-labelledby="example-preview" className={card}>
        <h2 className="text-2xl font-semibold text-ink" id="example-preview">
          Example preview
        </h2>
        <p className="mt-2 text-sm font-semibold text-warn">Example layout only. This is not an evaluation and not your resume.</p>
        <div className="mt-4 rounded-lg border border-[#CBD5E1] bg-card p-6 text-sm text-body">
          <p className="text-base font-semibold text-ink">Sample name</p>
          <p className="text-muted">Sample role</p>
          <h3 className="mt-5 border-b border-[#CBD5E1] pb-1 text-sm font-semibold text-ink">Experience</h3>
          <p className="mt-2">A sample bullet appears here.</p>
        </div>
      </section>

      <section className="grid gap-5 md:grid-cols-2">
        <Pricing signedIn={false} onAccount={onAccount} />
        <section className={card} id="faq">
          <h2 className="text-2xl font-semibold text-ink">Questions</h2>
          <dl className="mt-4 space-y-4">
            <div>
              <dt className="font-semibold text-ink">Which files can I upload?</dt>
              <dd className="mt-1">PDF and DOCX files up to 5 MiB.</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink">When is a score complete?</dt>
              <dd className="mt-1">Only a final server result is complete. A missing final score is shown as unavailable.</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink">How long is a resume kept?</dt>
              <dd className="mt-1">
                <a className="font-semibold text-primary" href="#retention">
                  90-day retention
                </a>
              </dd>
            </div>
          </dl>
        </section>
      </section>

      <section className={`${card} bg-info-bg text-info`} id="retention">
        <h2 className="text-lg font-semibold">Retention</h2>
        <p className="mt-2">
          Verified resumes are kept for 90 days. A separate privacy policy and terms page are not published yet. There is no
          backup-deletion promise beyond that retention period.
        </p>
        <button className="mt-3 font-semibold underline" onClick={onPricing} type="button">
          View pricing limits
        </button>
      </section>
    </div>
  );
}

function AccountView({ onUser }: { onUser: (user: SessionUser | null) => void }) {
  return (
    <div className="grid min-h-[70vh] lg:grid-cols-2">
      <section className="hidden bg-hero px-8 py-16 text-[#6B5C85] lg:flex lg:flex-col lg:justify-center lg:px-16">
        <BrandMark />
        <h1 className="mt-8 text-4xl font-semibold text-[#21143D]">
          A better resume.
          <br />A stronger first impression.
        </h1>
        <p className="mt-4 max-w-md">Build confidence in your next career move.</p>
        <div className={`${card} mt-8 max-w-md`}>
          <p className="font-semibold text-ink">Example evaluation</p>
          <p className="mt-1 text-sm text-warn">Illustration only. These bars are not a score.</p>
          <ExampleBar label="Content quality" />
          <ExampleBar label="Writing quality" />
          <ExampleBar label="Structure" />
        </div>
      </section>
      <section className="flex items-center bg-card px-6 py-12 sm:px-10">
        <div className="mx-auto w-full max-w-md">
          <h1 className="text-4xl font-semibold text-ink">Welcome back</h1>
          <p className="mt-2 text-muted">Sign in to your VerveCV account, or create one with the same form.</p>
          <div className="mt-6">
            <AuthPanel onUser={onUser} user={null} />
          </div>
        </div>
      </section>
    </div>
  );
}

function Pricing({ signedIn, onAccount }: { signedIn: boolean; onAccount?: () => void }) {
  return (
    <section className={signedIn ? "space-y-6" : card} id="pricing">
      {signedIn ? <PageHeader detail="No price, quota, or checkout is approved." title="Plans" /> : null}
      {!signedIn ? <h2 className="text-2xl font-semibold text-ink">Plans</h2> : null}
      <p className="mt-2 text-body">Choose a plan only after a price is approved. Nothing on this page starts a payment.</p>
      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <article className={card}>
          <h3 className="text-2xl font-semibold text-ink">Free</h3>
          <p className="mt-2">The current account can upload and score resumes. A price and a quota are not set.</p>
          {signedIn ? null : (
            <button className={`${primaryButton} mt-5`} onClick={onAccount} type="button">
              Get started
            </button>
          )}
        </article>
        <article className="rounded-xl border-2 border-primary bg-card p-6">
          <p className="inline-flex rounded-md bg-primary-muted px-2 py-1 text-sm font-semibold text-primary-bright">Pro</p>
          <h3 className="mt-3 text-2xl font-semibold text-ink">Not available</h3>
          <p className="mt-2">Pro benefits and pricing are not approved, so checkout stays closed.</p>
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
        <p className="mt-2">Verified resumes follow the 90-day retention policy. This screen cannot delete a backup.</p>
      </article>
      <article className={card}>
        <h2 className="text-xl font-semibold text-ink">Appearance</h2>
        <p className="mt-3 inline-flex rounded-md bg-primary-muted px-2 py-1 text-sm font-semibold text-primary-bright">Light mode</p>
      </article>
    </section>
  );
}

function ExampleBar({ label }: { label: string }) {
  return (
    <div className="mt-3">
      <p className="text-sm text-muted">{label}</p>
      <div className="mt-1 h-2 rounded-full bg-line">
        <div className="h-2 w-2/3 rounded-full bg-primary" />
      </div>
    </div>
  );
}

function BrandMark() {
  return <p className="text-2xl font-bold text-primary">VerveCV</p>;
}
