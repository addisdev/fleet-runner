// The token this browser holds, and the session cookie it is exchanged for.
//
// The token lives in localStorage and rides as a header on the dashboard's own
// fetches. <img> tags and the EventSource cannot set a header, so with
// FLEET_AUTH=tokens the token is also exchanged for an HttpOnly cookie
// (POST /api/session) that the collector honours for reads only -- a cookie
// that could mutate would be a cross-site request forgery waiting for a link.
import { useEffect, useState } from "preact/hooks";

const KEY = "fleet.dash.token";

export const getToken = () => localStorage.getItem(KEY) ?? "";

/** The header the dashboard's own requests carry, if it has a token. */
export const tokenHeader = (): Record<string, string> => {
  const t = getToken();
  return t ? { "x-fleet-token": t } : {};
};

function exchange(token: string) {
  void fetch("/api/session", { method: token ? "POST" : "DELETE", headers: token ? { "x-fleet-token": token } : {} }).catch(() => {});
}

export function setToken(token: string) {
  if (token) localStorage.setItem(KEY, token);
  else localStorage.removeItem(KEY);
  exchange(token);
  dispatchEvent(new Event("fleet:token"));
}

// The cookie lasts thirty days and the token in localStorage indefinitely, so
// renew the cookie on every load rather than wait for an image to 401.
if (getToken()) exchange(getToken());

export function useToken(): [string, (t: string) => void] {
  const [token, set] = useState(getToken());
  useEffect(() => {
    const on = () => set(getToken());
    addEventListener("fleet:token", on);
    return () => removeEventListener("fleet:token", on);
  }, []);
  return [token, setToken];
}
