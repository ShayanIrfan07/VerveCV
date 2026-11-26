import { useEffect, useRef } from "react";

export function DeleteResumeDialog({
  filename,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  filename: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(onCancel);
  const pendingRef = useRef(pending);
  onCancelRef.current = onCancel;
  pendingRef.current = pending;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    function focusable(): HTMLElement[] {
      if (!panel) {
        return [];
      }
      return Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled])"));
    }
    focusable()[0]?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (pendingRef.current) {
          return;
        }
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) {
        previous.focus();
      } else {
        document.getElementById("deletion-notice")?.focus();
      }
    };
  }, []);

  useEffect(() => {
    if (pending) {
      panelRef.current?.focus();
    }
  }, [pending]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-[rgba(15,23,42,0.35)] p-4 backdrop-blur-[4px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) {
          onCancel();
        }
      }}
    >
      <div
        aria-describedby="delete-resume-body"
        aria-labelledby="delete-resume-title"
        aria-modal="true"
        className="w-full max-w-[440px] rounded-2xl border border-[#E2E8F0] bg-white p-6"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="grid h-10 w-10 place-items-center rounded-full bg-[#FEE2E2] text-[#DC2626]">
          <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 20 20">
            <path d="M10 6.2v4.2" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="10" cy="13.6" fill="currentColor" r="0.9" />
            <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </div>
        <h2 className="mt-4 text-lg font-semibold text-[#17172B]" id="delete-resume-title">
          Delete this resume?
        </h2>
        <p className="mt-2 text-sm leading-6 text-[#334155]" id="delete-resume-body">
          You are about to permanently delete {filename}. The uploaded document and its associated evaluation results will be removed. This action cannot be undone.
        </p>
        {error ? (
          <p className="mt-3 text-sm text-[#BE123C]" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            className="inline-flex min-h-11 items-center rounded-[10px] border border-[#E2E8F0] bg-white px-4 text-sm font-semibold text-[#334155] hover:border-[#CBD5E1] disabled:opacity-60"
            disabled={pending}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            aria-busy={pending}
            className="inline-flex min-h-11 items-center rounded-[10px] bg-[#DC2626] px-4 text-sm font-semibold text-white hover:bg-[#B91C1C] disabled:opacity-60"
            disabled={pending}
            onClick={onConfirm}
            type="button"
          >
            {pending ? "Deleting…" : "Delete resume"}
          </button>
        </div>
      </div>
    </div>
  );
}
