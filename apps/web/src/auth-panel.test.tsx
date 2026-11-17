// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { AuthPanel } from "./auth-panel";
import type { SessionUser } from "./api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER: SessionUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "ada@example.com",
  displayName: "Ada",
};

function setReactInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const tracker = input as HTMLInputElement & { _valueTracker?: { setValue: (next: string) => void } };
  tracker._valueTracker?.setValue("");
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function textResponse(status: number, body: string) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("AuthPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderPanel(onUser = vi.fn()) {
    await act(async () => {
      root.render(<AuthPanel user={null} onUser={onUser} />);
    });
    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    const password = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      setReactInput(email, "ada@example.com");
      setReactInput(password, "correct-horse");
    });
    return { onUser, email, password };
  }

  function submitForm() {
    const form = container.querySelector("form");
    form?.requestSubmit();
  }

  function signInButton() {
    return [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign in") as HTMLButtonElement;
  }

  it("signs in and reports the session user", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { user: USER }));
    vi.stubGlobal("fetch", fetchMock);
    const { onUser } = await renderPanel();
    await act(async () => {
      submitForm();
    });
    expect(onUser).toHaveBeenCalledWith(USER);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Sign-in failed");
  });

  it("shows the authentication message for HTTP 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(401, { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" } }),
      ),
    );
    const { onUser } = await renderPanel();
    await act(async () => {
      submitForm();
    });
    expect(onUser).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Invalid email or password");
    expect(signInButton().disabled).toBe(false);
  });

  it("shows retry guidance for HTTP 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(429, { error: { code: "RATE_LIMITED", message: "Too many requests" } }, { "retry-after": "60" }),
      ),
    );
    await renderPanel();
    await act(async () => {
      submitForm();
    });
    expect(container.textContent).toContain("Too many requests. Try again in 60 seconds.");
  });

  it("shows a generic service error and request ID for HTTP 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(500, {
          error: { code: "INTERNAL_ERROR", message: "Internal error", requestId: "req-500" },
        }),
      ),
    );
    await renderPanel();
    await act(async () => {
      submitForm();
    });
    expect(container.textContent).toContain("The service could not sign you in. Request ID: req-500");
    expect(container.textContent).not.toContain("Internal error");
  });

  it("keeps an empty response body from throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await renderPanel();
    await act(async () => {
      submitForm();
    });
    expect(container.textContent).toContain("The service could not sign you in.");
    expect(signInButton().disabled).toBe(false);
  });

  it("keeps invalid JSON from throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(502, "<html>bad gateway</html>")));
    await renderPanel();
    await act(async () => {
      submitForm();
    });
    expect(container.textContent).toContain("The server returned an unreadable response.");
  });

  it("sends one login request when the button is activated twice", async () => {
    let release: (value: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(() => pending);
    vi.stubGlobal("fetch", fetchMock);
    await renderPanel();
    const form = container.querySelector("form");
    act(() => {
      form?.requestSubmit();
      form?.requestSubmit();
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => {
      release(jsonResponse(200, { user: USER }));
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("session persistence", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("restores the signed-in account after refresh and clears it after logout", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      if (url === "/api/v1/me" && method === "GET") {
        return jsonResponse(200, { user: USER });
      }
      if (url.startsWith("/api/v1/evaluations")) {
        return jsonResponse(200, { evaluations: [], pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null } });
      }
      if (url === "/api/v1/auth/logout" && method === "POST") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(404, { error: { message: "Not found" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<App />);
    });
    expect(container.textContent).toContain("ada@example.com");

    const signOut = [...container.querySelectorAll("button")].find((button) => button.textContent === "Sign out");
    await act(async () => {
      signOut?.click();
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/v1/auth/logout"))).toBe(true);
    expect(container.textContent).toContain("Sign in");
    expect(container.textContent).not.toContain("ada@example.com");
  });
});
