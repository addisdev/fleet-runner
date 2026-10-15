// Mutating calls, and the token they may need to carry (see token.ts).
import { useState } from "preact/hooks";
import { ApiError } from "./api.js";
import { getToken } from "./token.js";

export { getToken, setToken, useToken } from "./token.js";

export async function mutate<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-fleet-token": token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401) {
    // Naming the missing header is true and useless. Say what to do.
    throw new ApiError(401, token
      ? "That dashboard token was rejected. Check it on the System screen."
      : "This collector needs a dashboard token — paste it in the banner above, or on the System screen.");
  }
  if (!res.ok) throw new ApiError(res.status, json.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

/**
 * Wraps one mutation with the state a button needs: in-flight, error, and the
 * result note the server sent back. Errors are surfaced, never swallowed — a
 * cancel that silently failed is worse than one that visibly did.
 */
export function useMutation<T>(run: () => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<T | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await run());
      return true;
    } catch (e) {
      setError(e as Error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, result, go, reset: () => { setError(null); setResult(null); } };
}
