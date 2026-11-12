const API = import.meta.env.VITE_API_URL ?? "";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T | null }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status === 204) {
    return { status: response.status, body: null };
  }
  const body = (await response.json()) as T;
  return { status: response.status, body };
}
