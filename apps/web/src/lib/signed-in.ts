// A note in this browser that someone is signed in here. The session cookie is httpOnly, so pages that are the same for
// everyone (the public site's header, a sign-in page brought back by the Back button) cannot see it. It is only a hint:
// the server still decides who is signed in. Set by the app shell, cleared by Sign out or when there is no session.
const KEY = "bmu-signed-in";

export function markSignedIn() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {}
}
export function clearSignedIn() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
export function signedInHint() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * A refused request sent them to sign-in but their session turns out to be live: send them back, but only once every
 * 30 seconds, so a request that keeps being refused cannot bounce them back and forth.
 */
const RESUMED_KEY = "bmu-resumed-at";
export function mayResume() {
  try {
    const last = Number(sessionStorage.getItem(RESUMED_KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(RESUMED_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}
