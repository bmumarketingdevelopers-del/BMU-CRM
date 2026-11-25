import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { ApiError, createApiClient } from '@bmu/shared';

/**
 * API base URL. Set EXPO_PUBLIC_API_URL in .env to override. Otherwise, in development
 * we reuse the IP of the computer running `expo start`, so the app on your phone
 * reaches the API on that computer over the same Wi-Fi without any setup.
 */
function resolveApiUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host ?? 'localhost'}:4000`;
}

const TOKEN_KEY = 'bmu_session';
let token: string | null = null;

export const session = {
  /** The token in memory (v13 live updates). */
  current() {
    return token;
  },
  async load() {
    token = await SecureStore.getItemAsync(TOKEN_KEY);
    return token;
  },
  async save(value: string) {
    token = value;
    await SecureStore.setItemAsync(TOKEN_KEY, value);
  },
  async clear() {
    token = null;
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  },
};

const expiredListeners = new Set<() => void>();
/** Runs `fn` when the API says the saved session is no longer valid (expired, signed out elsewhere, or suspended). */
export function onSessionExpired(fn: () => void) {
  expiredListeners.add(fn);
  return () => {
    expiredListeners.delete(fn);
  };
}

/** The server itself says this sign-in is over (not a weak signal, a timeout or a server error). */
export const isSignedOutError = (e: unknown) => e instanceof ApiError && e.status === 401;

let checking = false;
/** A refused request is checked once more before anyone is signed out; only a clear "not signed in" ends the session. */
async function confirmExpired() {
  const refused = token;
  if (!refused || checking) return;
  checking = true;
  try {
    await api.auth.me();
  } catch (e) {
    if (isSignedOutError(e) && token === refused) {
      await session.clear();
      expiredListeners.forEach((fn) => fn());
    }
  } finally {
    checking = false;
  }
}

export const API_URL = resolveApiUrl();
export const api = createApiClient(API_URL, {
  getToken: () => token,
  onUnauthorized: () => void confirmExpired(),
});

/** Files are served by the API at /files/:id; web URLs are '/api/files/:id'. */
export const fileUrl = (url: string) => (url.startsWith('/api/') ? `${API_URL}${url.slice(4)}` : url);
export const authHeaders = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});
