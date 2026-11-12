import type { ErrorEnvelope } from "@vervecv/contracts";

export function errorBody(code: string, message: string, requestId: string): ErrorEnvelope {
  return { error: { code, message, requestId } };
}
