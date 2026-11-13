import { useEffect, useState } from "react";
import { apiRequest, type SessionUser } from "./api";
import { AuthPanel } from "./auth-panel";
import { UploadPanel } from "./upload-panel";

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(null);

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

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-6 py-12">
      <header>
        <p className="text-sm font-medium tracking-wide text-slate-600">VerveCV</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">Make every bullet count.</h1>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-700">
          Upload a PDF or DOCX resume. After the server verifies the file, the dashboard shows a provisional score.
          Withheld criteria stay out of the denominator, and the score is not rescaled to 100.
        </p>
      </header>
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <AuthPanel onUser={setUser} user={user} />
        <UploadPanel user={user} />
      </div>
    </main>
  );
}
