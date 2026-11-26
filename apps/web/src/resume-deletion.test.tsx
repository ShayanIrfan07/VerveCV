// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteResumeDialog } from "./delete-resume-dialog";
import { UploadPanel } from "./upload-panel";
import type { HistoryItem } from "./score-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "ada@example.com",
  displayName: "Ada",
};

const FIRST: HistoryItem = {
  id: "eval-1",
  resumeId: "resume-1",
  resumeVersionId: "version-1",
  originalFilename: "Software_Engineer_Resume.pdf",
  mimeType: "application/pdf",
  status: "provisional",
  score: 11,
  createdAt: "2026-11-26T00:00:00.000Z",
};

const SECOND: HistoryItem = {
  id: "eval-2",
  resumeId: "resume-2",
  resumeVersionId: "version-2",
  originalFilename: "Backend_Developer_Resume.pdf",
  mimeType: "application/pdf",
  status: "complete",
  score: 40,
  createdAt: "2026-11-24T00:00:00.000Z",
};

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(label) || button.getAttribute("aria-label") === label);
}

describe("resume deletion", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks for confirmation, leaves the resume in place when cancelled, and refreshes after the server accepts deletion", async () => {
    let items = [FIRST, SECOND];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/v1/evaluations?") && method === "GET") {
        return json({
          evaluations: items,
          pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
        });
      }
      if (url === "/api/v1/resumes/resume-1" && method === "DELETE") {
        items = items.filter((item) => item.resumeId !== "resume-1");
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, cleanup } = render(<UploadPanel user={USER} />);
    await flushAsync();

    expect(container.textContent).toContain("Recent resumes");
    expect(container.textContent).toContain("2 resumes");
    expect(articleText(container, "Total resumes")).toContain("2");
    expect(container.textContent).toContain("Software_Engineer_Resume.pdf");

    const remove = buttonNamed(container, "Delete Software_Engineer_Resume.pdf");
    expect(remove).toBeDefined();
    await act(async () => {
      remove?.click();
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Delete this resume?");
    expect(dialog?.textContent).toContain("Software_Engineer_Resume.pdf");
    expect(dialog?.textContent).toContain("associated evaluation results");
    expect(dialog?.className).toContain("max-w-[440px]");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flushAsync();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("Software_Engineer_Resume.pdf");

    await act(async () => {
      buttonNamed(container, "Delete Software_Engineer_Resume.pdf")?.click();
    });
    await act(async () => {
      buttonNamed(document.body, "Cancel")?.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "DELETE")).toBe(false);

    await act(async () => {
      buttonNamed(container, "Delete Software_Engineer_Resume.pdf")?.click();
    });
    await act(async () => {
      buttonNamed(document.body, "Delete resume")?.click();
    });
    await flushAsync();

    expect(container.textContent).toContain("Deletion requested. Software_Engineer_Resume.pdf is no longer available.");
    const heading = [...container.querySelectorAll("h2")].find((node) => node.textContent === "Recent resumes");
    expect(heading?.parentElement?.parentElement?.textContent).not.toContain("Software_Engineer_Resume.pdf");
    expect(container.textContent).toContain("Backend_Developer_Resume.pdf");
    expect(container.textContent).toContain("1 resume");
    expect(articleText(container, "Total resumes")).toContain("1");
    expect(articleText(container, "Latest score")).toContain("40");
    cleanup();
  });

  it("keeps the resume listed when deletion fails and allows a retry", async () => {
    let status = 500;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/v1/evaluations?")) {
        return json({
          evaluations: [FIRST],
          pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
        });
      }
      if (method === "DELETE") {
        if (status === 0) {
          throw new TypeError("network down");
        }
        const responseStatus = status;
        if (responseStatus === 204) {
          return new Response(null, { status: 204 });
        }
        const message = responseStatus === 404 ? "Not found" : "Server error";
        return json({ error: { code: responseStatus === 404 ? "NOT_FOUND" : "SERVER_ERROR", message } }, responseStatus, responseStatus === 429 ? { "retry-after": "3" } : {});
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSessionExpired = vi.fn();
    const { container, cleanup } = render(<UploadPanel onSessionExpired={onSessionExpired} user={USER} />);
    await flushAsync();

    async function attempt() {
      await act(async () => {
        buttonNamed(container, "Delete Software_Engineer_Resume.pdf")?.click();
      });
      await act(async () => {
        buttonNamed(document.body, "Delete resume")?.click();
      });
      await flushAsync();
    }

    await attempt();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("The resume could not be deleted. Try again.");
    expect(container.textContent).toContain("Software_Engineer_Resume.pdf");

    status = 429;
    await act(async () => {
      buttonNamed(document.body, "Delete resume")?.click();
    });
    await flushAsync();
    expect(document.body.textContent).toContain("Too many requests. Try again in 3 seconds.");
    expect(container.textContent).toContain("Software_Engineer_Resume.pdf");

    status = 401;
    await act(async () => {
      buttonNamed(document.body, "Delete resume")?.click();
    });
    await flushAsync();
    expect(onSessionExpired).toHaveBeenCalled();
    expect(document.body.textContent).toContain("Sign in again to delete this resume.");

    status = 404;
    await act(async () => {
      buttonNamed(document.body, "Delete resume")?.click();
    });
    await flushAsync();
    expect(document.body.textContent).toContain("This resume is no longer available.");

    status = 0;
    await act(async () => {
      buttonNamed(document.body, "Delete resume")?.click();
    });
    await flushAsync();
    expect(document.body.textContent).toContain("Check your connection and try again.");
    expect(container.textContent).toContain("Software_Engineer_Resume.pdf");

    status = 204;
    await act(async () => {
      buttonNamed(document.body, "Delete resume")?.click();
    });
    await flushAsync();
    expect(container.textContent).toContain("Deletion requested.");
    cleanup();
  });

  it("ignores a second confirmation while the first request is still running and clears the open evaluation", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deleteCalls = 0;
    let items = [FIRST];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      if (url === "/api/v1/evaluations/eval-1") {
        return json({
          evaluation: {
            ...FIRST,
            notice: "This result is provisional and is not a complete 100-point score.",
            areas: [{ label: "Contact information", state: "passed" }],
            unavailable: [],
          },
          findings: [],
        });
      }
      if (url.startsWith("/api/v1/evaluations?")) {
        return json({
          evaluations: items,
          pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
        });
      }
      if (url.includes("/view-url")) {
        return json({ error: { message: "Not found" } }, 404);
      }
      if (method === "DELETE") {
        deleteCalls += 1;
        await gate;
        items = [];
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container, cleanup } = render(<UploadPanel user={USER} />);
    await flushAsync();
    await act(async () => {
      buttonNamed(container, "Software_Engineer_Resume.pdf")?.click();
    });
    await flushAsync();
    expect(container.querySelector('[data-testid="analysis-score"]')?.textContent).toBe("11");

    const headerDelete = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Delete Software_Engineer_Resume.pdf" && button.closest("header"),
    );
    await act(async () => {
      headerDelete?.click();
    });
    const confirm = buttonNamed(document.body, "Delete resume");
    await act(async () => {
      confirm?.click();
      confirm?.click();
    });
    expect(confirm?.hasAttribute("disabled")).toBe(true);
    expect(confirm?.textContent).toContain("Deleting");
    expect(deleteCalls).toBe(1);
    release?.();
    await flushAsync();
    expect(deleteCalls).toBe(1);
    expect(container.querySelector('[data-testid="analysis-score"]')).toBeNull();
    expect(container.textContent).toContain("No scores yet.");
    expect(container.textContent).toContain("Deletion requested.");
    cleanup();
  });

  it("traps focus in the confirmation dialog and restores it on Escape", () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.appendChild(opener);
    opener.focus();
    const onCancel = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        <DeleteResumeDialog error={null} filename="Java_Developer_CV.pdf" onCancel={onCancel} onConfirm={() => undefined} pending={false} />,
      );
    });
    const cancel = buttonNamed(document.body, "Cancel");
    const confirm = buttonNamed(document.body, "Delete resume");
    expect(document.activeElement).toBe(cancel);
    confirm?.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(cancel);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, shiftKey: true }));
    expect(document.activeElement).toBe(confirm);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    expect(document.activeElement).toBe(opener);
  });

  it("labels delete on the My resumes page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          evaluations: [FIRST],
          pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
        }),
      ),
    );
    const { container, cleanup } = render(<UploadPanel focus="history" user={USER} />);
    await flushAsync();
    expect(container.textContent).toContain("My resumes");
    expect(buttonNamed(container, "Delete Software_Engineer_Resume.pdf")).toBeDefined();
    cleanup();
  });
});

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function articleText(container: HTMLElement, label: string): string {
  return [...container.querySelectorAll("article")].find((article) => article.textContent?.includes(label))?.textContent ?? "";
}
