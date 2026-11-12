import { useState, type FormEvent } from "react";
import { apiRequest, type SessionUser } from "./api";

interface AuthPanelProps {
  user: SessionUser | null;
  onUser: (user: SessionUser | null) => void;
}

export function AuthPanel({ user, onUser }: AuthPanelProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");

  async function register() {
    const created = await apiRequest<{ user?: SessionUser; error?: { message: string } }>("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, displayName: displayName || undefined }),
    });
    if (created.status !== 201) {
      setMessage(created.body?.error?.message ?? "Registration failed.");
      return;
    }
    await signIn();
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    await signIn();
  }

  async function signIn() {
    const result = await apiRequest<{ user?: SessionUser; error?: { message: string } }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (result.status !== 200 || !result.body?.user) {
      setMessage(result.body?.error?.message ?? "Sign-in failed.");
      return;
    }
    onUser(result.body.user);
    setMessage("");
  }

  async function logout() {
    await apiRequest("/api/v1/auth/logout", { method: "POST" });
    onUser(null);
  }

  if (user) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-950">Account</h2>
        <p className="mt-2 text-slate-700">{user.email}</p>
        <button className="mt-4 rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => void logout()} type="button">
          Sign out
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-slate-950">Account</h2>
      <form className="mt-4 grid gap-3" onSubmit={(event) => void login(event)}>
        <label className="grid gap-1 text-sm text-slate-700">
          Email
          <input className="rounded-lg border border-slate-300 px-3 py-2" value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
        </label>
        <label className="grid gap-1 text-sm text-slate-700">
          Password
          <input className="rounded-lg border border-slate-300 px-3 py-2" value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={8} required />
        </label>
        <label className="grid gap-1 text-sm text-slate-700">
          Display name
          <input className="rounded-lg border border-slate-300 px-3 py-2" value={displayName} onChange={(event) => setDisplayName(event.target.value)} type="text" />
        </label>
        <div className="flex gap-2">
          <button className="rounded-lg bg-slate-950 px-3 py-2 text-sm text-white" type="submit">
            Sign in
          </button>
          <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm" onClick={() => void register()} type="button">
            Create account
          </button>
        </div>
        {message ? <p className="text-sm text-red-700">{message}</p> : null}
      </form>
    </section>
  );
}
