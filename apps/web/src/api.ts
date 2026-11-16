const API = import.meta.env.VITE_API_URL ?? "";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface ApiResult<T> {
  status: number;
  body: T | null;
  retryAfterSeconds: number | null;
  unreadable: boolean;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const retryAfter = retryAfterSeconds(response);
  if (response.status === 204) {
    return { status: response.status, body: null, retryAfterSeconds: retryAfter, unreadable: false };
  }
  const text = await response.text();
  if (text.trim() === "") {
    return { status: response.status, body: null, retryAfterSeconds: retryAfter, unreadable: false };
  }
  try {
    return {
      status: response.status,
      body: JSON.parse(text) as T,
      retryAfterSeconds: retryAfter,
      unreadable: false,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { status: response.status, body: null, retryAfterSeconds: retryAfter, unreadable: true };
    }
    throw error;
  }
}
