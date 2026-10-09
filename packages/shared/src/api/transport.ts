/** The HTTP helpers each API area module builds on (see createApiClient). */
export type Transport = {
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
  patch: <T>(path: string, body: unknown) => Promise<T>;
  put: <T>(path: string, body: unknown) => Promise<T>;
  del: <T>(path: string) => Promise<T>;
  /**
   * v22: puts one file straight into Supabase Storage and returns the X-BMU-Stored-File header that hands it to an
   * upload endpoint, or null when the API keeps files on its own disk (then send the file in the request as usual).
   */
  storeFile: (file: Blob, field?: string) => Promise<Record<string, string> | null>;
};
