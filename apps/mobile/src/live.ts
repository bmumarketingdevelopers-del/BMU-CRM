// v13 live updates on the phone: one server-sent-events stream (GET /realtime/stream) read with XMLHttpRequest,
// which React Native streams as it arrives. Screens using useData() reload quietly when records change. The stream
// pauses while the app is in the background and catches up when it comes back.
import { AppState } from 'react-native';
import { API_URL, session } from './api';

type Listener = () => void;
const listeners = new Set<Listener>();
let xhr: XMLHttpRequest | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let settle: ReturnType<typeof setTimeout> | null = null;
let seen = 0;
let pending = '';
let enabled = true;
let started = false;

/** Reconnect after this much text so the response buffer never grows without limit. */
const MAX_BUFFER = 512 * 1024;

function notifySoon() {
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    settle = null;
    listeners.forEach((fn) => fn());
  }, 600);
}

function handle(block: string) {
  const data = block
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6))
    .join('\n');
  if (!data) return;
  try {
    const msg = JSON.parse(data) as { kind: string; flags?: Record<string, boolean> };
    if (msg.kind === 'hello') enabled = msg.flags?.live_updates !== false;
    else if (msg.kind === 'change' && enabled) notifySoon();
  } catch {
    // ignore a malformed line
  }
}

function connect() {
  const token = session.current();
  if (xhr || !token) return;
  const req = new XMLHttpRequest();
  xhr = req;
  seen = 0;
  pending = '';
  req.open('GET', `${API_URL}/realtime/stream`);
  req.setRequestHeader('Authorization', `Bearer ${token}`);
  req.setRequestHeader('Accept', 'text/event-stream');
  req.onprogress = () => {
    const text = req.responseText ?? '';
    pending += text.slice(seen);
    seen = text.length;
    const parts = pending.split('\n\n');
    pending = parts.pop() ?? '';
    parts.forEach(handle);
    if (seen > MAX_BUFFER) req.abort();
  };
  const reconnect = () => {
    if (xhr !== req) return;
    xhr = null;
    if (started && AppState.currentState === 'active') retry = setTimeout(connect, 3_000);
  };
  req.onerror = reconnect;
  req.onload = reconnect;
  req.onabort = reconnect;
  req.send();
}

function stop() {
  if (retry) clearTimeout(retry);
  retry = null;
  const req = xhr;
  xhr = null;
  req?.abort();
}

AppState.addEventListener('change', (state) => {
  if (!started) return;
  if (state === 'active') {
    connect();
    notifySoon(); // anything could have changed while away
  } else stop();
});

/** Runs `fn` after records change anywhere (debounced). Starts the stream on first use. */
export function onLiveChange(fn: Listener) {
  listeners.add(fn);
  started = true;
  connect();
  return () => {
    listeners.delete(fn);
  };
}

/** Called on sign-out. */
export function stopLive() {
  started = false;
  stop();
}
