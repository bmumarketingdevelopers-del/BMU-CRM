// v20 biometric lock: optional Face ID / fingerprint (or the phone's passcode) when the app opens
// or comes back after a minute in the background. Turned on per phone from More.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { fonts, ui } from './theme';
import { Button, Muted } from './ui';

const KEY = 'bmu_lock';
const AWAY_MS = 60_000;

export async function lockAvailable() {
  try {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

async function check(prompt = 'Unlock BMU Hub') {
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, fallbackLabel: 'Use passcode' });
  return r.success;
}

export function useLock(active: boolean) {
  const [enabled, setEnabled] = useState(false);
  const [locked, setLocked] = useState(false);
  const away = useRef<number | null>(null);

  useEffect(() => {
    void SecureStore.getItemAsync(KEY).then((v) => {
      setEnabled(v === '1');
      if (v === '1') setLocked(true);
    });
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') away.current = Date.now();
      if (s === 'active' && away.current && Date.now() - away.current > AWAY_MS && enabled) setLocked(true);
      if (s === 'active') away.current = null;
    });
    return () => sub.remove();
  }, [enabled]);

  const unlock = useCallback(async () => {
    if (await check()) setLocked(false);
  }, []);

  const toggle = useCallback(async () => {
    if (!enabled && !(await lockAvailable())) return 'Set up Face ID, a fingerprint or a passcode on this phone first.';
    if (!(await check(enabled ? 'Turn off the app lock' : 'Turn on the app lock'))) return null;
    const next = !enabled;
    await SecureStore.setItemAsync(KEY, next ? '1' : '0');
    setEnabled(next);
    return next ? 'App lock is on.' : 'App lock is off.';
  }, [enabled]);

  return { enabled, locked: active && enabled && locked, unlock, toggle };
}

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  useEffect(() => {
    onUnlock();
  }, [onUnlock]);
  return (
    <View style={[StyleSheet.absoluteFill, s.wrap]}>
      <Text style={s.logo}>
        BMU<Text style={{ color: ui.accent }}>.</Text>
      </Text>
      <Muted style={{ marginVertical: 16, textAlign: 'center' }}>BMU Hub is locked.</Muted>
      <Button title="Unlock" onPress={onUnlock} />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: ui.bg, alignItems: 'stretch', justifyContent: 'center', padding: 32, zIndex: 50 },
  logo: { fontFamily: fonts.display, fontSize: 32, color: ui.ink, textAlign: 'center' },
});
