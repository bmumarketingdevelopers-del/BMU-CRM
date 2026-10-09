import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { fonts, ui } from './theme';
import { isNetworkError } from '@bmu/shared';
import { onLiveChange } from './live';
import { cache } from './offline';

/**
 * Loads data on mount with pull-to-refresh. v13: reloads quietly when records change (live updates).
 * v20: with a cacheKey the last copy is kept on the phone and shown when there is no connection.
 */
export function useData<T>(load: () => Promise<T>, deps: unknown[] = [], opts: { cacheKey?: string } = {}) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [savedAt, setSavedAt] = useState<number>();
  const key = opts.cacheKey;
  const run = useCallback(
    () =>
      load()
        .then((d) => {
          setData(d);
          setError(undefined);
          setSavedAt(undefined);
          if (key) void cache.set(key, d);
        })
        .catch(async (e: Error) => {
          const copy = key && isNetworkError(e) ? await cache.get<T>(key) : null;
          if (copy) {
            setData(copy.data);
            setSavedAt(copy.at);
            setError(undefined);
          } else setError(isNetworkError(e) ? 'No connection. Pull down to try again.' : e.message);
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...deps, key],
  );
  useEffect(() => {
    run();
  }, [run]);
  useEffect(() => onLiveChange(() => void run()), [run]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await run();
    setRefreshing(false);
  }, [run]);
  return { data, setData, error, refreshing, refresh, reload: run, offline: savedAt !== undefined, savedAt };
}

/** v20: "You're offline" strip, with how old the copy is and what is waiting to sync. */
export function OfflineBanner({ savedAt, pending = 0, online = true }: { savedAt?: number; pending?: number; online?: boolean }) {
  if (online && savedAt === undefined && !pending) return null;
  const parts = [
    !online || savedAt !== undefined ? "You're offline" : 'Back online',
    savedAt !== undefined ? `showing the copy from ${when(new Date(savedAt).toISOString())}` : null,
    pending ? `${pending} change${pending === 1 ? '' : 's'} waiting to sync` : null,
  ].filter(Boolean);
  return (
    <View style={[s.card, { borderColor: ui.warn, borderLeftWidth: 3, paddingVertical: 10 }]}>
      <Text style={s.text}>{parts.join(' · ')}</Text>
    </View>
  );
}

export function Screen({ children, refreshing = false, onRefresh }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  return (
    <ScrollView
      style={{ backgroundColor: ui.bg }}
      contentContainerStyle={s.body}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ui.ink} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export const Title = ({ children, sub }: { children: ReactNode; sub?: ReactNode }) => (
  <View style={{ marginBottom: 20 }}>
    <Text style={s.h1}>{children}</Text>
    {sub ? <Text style={[s.muted, { marginTop: 4 }]}>{sub}</Text> : null}
  </View>
);

export const Section = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <View style={s.sectionRow}>
    <Text style={s.section}>{children}</Text>
    {action}
  </View>
);

export const Muted = ({ children, style }: { children: ReactNode; style?: object }) => <Text style={[s.muted, style]}>{children}</Text>;
export const Body = ({ children, bold, style }: { children: ReactNode; bold?: boolean; style?: object }) => <Text style={[bold ? s.bold : s.text, style]}>{children}</Text>;

export function Card({ children, onPress, tone }: { children: ReactNode; onPress?: () => void; tone?: 'warn' | 'bad' | 'good' }) {
  const border = tone === 'warn' ? ui.warn : tone === 'bad' ? ui.bad : tone === 'good' ? ui.accent : ui.line;
  const inner = <View style={[s.card, { borderColor: border, borderLeftWidth: tone ? 3 : 1 }]}>{children}</View>;
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>{inner}</Pressable> : inner;
}

export function Row({ title, sub, right, onPress }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [s.row, { opacity: pressed ? 0.6 : 1 }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.bold} numberOfLines={2}>
          {title}
        </Text>
        {sub ? (
          <Text style={[s.muted, { marginTop: 2 }]} numberOfLines={2}>
            {sub}
          </Text>
        ) : null}
      </View>
      {right}
      {onPress ? <Text style={[s.muted, { marginLeft: 8 }]}>›</Text> : null}
    </Pressable>
  );
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'dark' }) {
  const bg = { neutral: ui.soft, good: '#8BB72C33', warn: '#F2D27A66', bad: '#E7735C40', dark: ui.ink }[tone];
  return <Text style={[s.badge, { backgroundColor: bg, color: tone === 'dark' ? '#fff' : ui.ink }]}>{children}</Text>;
}

export function Button({ title, onPress, variant = 'primary', busy, disabled }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'accent'; busy?: boolean; disabled?: boolean }) {
  const bg = variant === 'primary' ? ui.ink : variant === 'accent' ? ui.accent : 'transparent';
  const color = variant === 'primary' ? '#fff' : ui.ink;
  return (
    <Pressable onPress={onPress} disabled={busy || disabled} style={({ pressed }) => [s.button, { backgroundColor: bg, borderWidth: variant === 'secondary' ? 1 : 0, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }]}>
      {busy ? <ActivityIndicator color={color} /> : <Text style={[s.buttonText, { color }]}>{title}</Text>}
    </Pressable>
  );
}

export const Input = (p: TextInputProps) => <TextInput placeholderTextColor={ui.muted} {...p} style={[s.input, p.multiline ? { minHeight: 80, textAlignVertical: 'top' } : null, p.style]} />;

export function Stats({ items }: { items: { label: string; value: ReactNode; tone?: 'warn' | 'bad' }[] }) {
  return (
    <View style={s.stats}>
      {items.map((i) => (
        <View key={i.label} style={s.stat}>
          <Text style={s.muted}>{i.label}</Text>
          <Text style={[s.statValue, i.tone === 'bad' ? { color: '#b4432c' } : i.tone === 'warn' ? { color: '#9a6b00' } : null]}>{i.value}</Text>
        </View>
      ))}
    </View>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <Text style={[s.muted, { textAlign: 'center', paddingVertical: 24 }]}>{children}</Text>;
export const ErrorText = ({ children }: { children?: ReactNode }) => (children ? <Text style={s.error}>{children}</Text> : null);
export const Loading = () => <ActivityIndicator color={ui.ink} style={{ marginTop: 40 }} />;

export function Back({ onPress, label = 'Back' }: { onPress: () => void; label?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={12} style={{ marginBottom: 12 }}>
      <Text style={[s.muted, { textDecorationLine: 'underline' }]}>‹ {label}</Text>
    </Pressable>
  );
}

export function Pills<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} style={[s.pill, o.value === value ? { backgroundColor: ui.ink, borderColor: ui.ink } : null]}>
          <Text style={[s.text, { fontSize: 13, color: o.value === value ? '#fff' : ui.ink }]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
export const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

export const s = StyleSheet.create({
  body: { padding: 20, paddingBottom: 56, flexGrow: 1 },
  h1: { fontFamily: fonts.bodyBold, fontSize: 26, color: ui.ink, letterSpacing: -0.5 },
  section: { fontFamily: fonts.bodyBold, fontSize: 12, color: ui.muted, textTransform: 'uppercase', letterSpacing: 1.2 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, marginBottom: 10 },
  text: { fontFamily: fonts.body, color: ui.ink, fontSize: 15 },
  bold: { fontFamily: fonts.bodyBold, color: ui.ink, fontSize: 15 },
  muted: { fontFamily: fonts.body, color: ui.muted, fontSize: 13 },
  card: { backgroundColor: ui.bg, borderWidth: 1, padding: 16, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderColor: ui.line, gap: 8 },
  badge: { fontFamily: fonts.body, fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden', alignSelf: 'flex-start' },
  button: { paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center', borderColor: ui.ink, marginTop: 10 },
  buttonText: { fontFamily: fonts.bodyBold, fontSize: 15 },
  input: { borderWidth: 1, borderColor: ui.line, paddingHorizontal: 12, paddingVertical: 11, fontFamily: fonts.body, color: ui.ink, fontSize: 15, marginTop: 8, backgroundColor: '#fff' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', borderWidth: 1, borderColor: ui.line },
  stat: { width: '50%', padding: 14, borderColor: ui.line, borderRightWidth: 1, borderBottomWidth: 1 },
  statValue: { fontFamily: fonts.bodyBold, fontSize: 24, color: ui.ink, marginTop: 4 },
  error: { fontFamily: fonts.body, color: '#b4432c', marginTop: 10 },
  pill: { borderWidth: 1, borderColor: ui.line, paddingHorizontal: 12, paddingVertical: 6 },
});
