import { useRef, useState, type FormEvent } from "react";
import { apiRequest, type ApiResult, type SessionUser } from "./api";

interface AuthPanelProps {
  user: SessionUser | null;
  onUser: (user: SessionUser | null) => void;
}

interface AuthBody {
  user?: SessionUser;
  error?: { message?: string; requestId?: string };
}

export function AuthPanel({ user, onUser }: AuthPanelProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  function begin(): boolean {
    if (pendingRef.current) {
      return false;
    }
    pendingRef.current = true;
    setPending(true);
    return true;
  }

  function finish() {
    pendingRef.current = false;
    setPending(false);
  }

  function applySession(result: ApiResult<AuthBody>) {
    if (result.unreadable) {
      setMessage("The server returned an unreadable response.");
      return;
    }
    if (result.status === 200 && result.body?.user) {
      onUser(result.body.user);
      setMessage("");
      return;
    }
    setMessage(failureMessage(result));
  }

  async function register() {
    if (!begin()) {
      return;
    }
    try {
      const created = await apiRequest<AuthBody>("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, displayName: displayName || undefined }),
      });
      if (created.unreadable) {
        setMessage("The server returned an unreadable response.");
        return;
      }
      if (created.status !== 201) {
        setMessage(failureMessage(created, "register"));
        return;
      }
      const signedIn = await apiRequest<AuthBody>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      applySession(signedIn);
    } catch (error) {
      setMessage("The service could not complete the request.");
      console.error(error);
    } finally {
      finish();
    }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    if (!begin()) {
      return;
    }
    try {
      const result = await apiRequest<AuthBody>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      applySession(result);
    } catch (error) {
      setMessage("The service could not sign you in.");
      console.error(error);
    } finally {
      finish();
    }
  }

  async function logout() {
    if (!begin()) {
      return;
    }
    try {
      const result = await apiRequest<AuthBody>("/api/v1/auth/logout", { method: "POST" });
      if (result.status === 204) {
        onUser(null);
        setMessage("");
        return;
      }
      setMessage(failureMessage(result, "logout"));
    } catch (error) {
      setMessage("The service could not sign you out.");
      console.error(error);
    } finally {
      finish();
    }
  }

  if (user) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-950">Account</h2>
        <p className="mt-2 text-slate-700">{user.email}</p>
        <button
          className="mt-4 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
          disabled={pending}
          onClick={() => void logout()}
          type="button"
        >
          Sign out
        </button>
        {message ? <p className="mt-3 text-sm text-red-700">{message}</p> : null}
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-slate-950">Account</h2>
      <form className="mt-4 grid gap-3" onSubmit={(event) => void login(event)}>
        <label className="grid gap-1 text-sm text-slate-700">
          Email
          <input
            className="rounded-lg border border-slate-300 px-3 py-2"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            autoComplete="username"
            required
          />
        </label>
        <label className="grid gap-1 text-sm text-slate-700">
          Password
          <input
            className="rounded-lg border border-slate-300 px-3 py-2"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
            minLength={8}
            required
          />
        </label>
        <label className="grid gap-1 text-sm text-slate-700">
          Display name
          <input
            className="rounded-lg border border-slate-300 px-3 py-2"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            type="text"
            autoComplete="nickname"
          />
        </label>
        <div className="flex gap-2">
          <button
            className="rounded-lg bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-60"
            disabled={pending}
            type="submit"
          >
            {pending ? "Signing in" : "Sign in"}
          </button>
          <button
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-60"
            disabled={pending}
            onClick={() => void register()}
            type="button"
          >
            Create account
          </button>
        </div>
        {message ? (
          <p className="text-sm text-red-700" role="alert">
            {message}
          </p>
        ) : null}
      </form>
    </section>
  );
}

type AuthOperation = "register" | "login" | "logout";

function serviceUnavailableMessage(operation: AuthOperation, requestId?: string): string {
  const service =
    operation === "register" ? "Registration service" : operation === "logout" ? "Sign-out service" : "Sign-in service";
  const base = `${service} is temporarily unavailable.`;
  return requestId ? `${base} Request ID: ${requestId}` : base;
}

function failureFallback(operation: AuthOperation): string {
  if (operation === "register") {
    return "Registration failed.";
  }
  if (operation === "logout") {
    return "Sign-out failed.";
  }
  return "Sign-in failed.";
}

function failureMessage(result: ApiResult<AuthBody>, operation: AuthOperation = "login"): string {
  const error = result.body?.error;
  if (result.status === 401) {
    return error?.message ?? "The email or password is incorrect.";
  }
  if (result.status === 429) {
    const base = error?.message ?? "Too many attempts.";
    const sentence = /[.!?]$/.test(base) ? base : `${base}.`;
    if (result.retryAfterSeconds === null) {
      return `${sentence} Try again shortly.`;
    }
    return `${sentence} Try again in ${result.retryAfterSeconds} seconds.`;
  }
  if (result.status >= 500) {
    return serviceUnavailableMessage(operation, error?.requestId);
  }
  return error?.message ?? failureFallback(operation);
}
