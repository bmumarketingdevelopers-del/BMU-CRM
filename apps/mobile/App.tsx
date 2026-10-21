import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useFonts, ZenDots_400Regular } from '@expo-google-fonts/zen-dots';
import { AlbertSans_400Regular, AlbertSans_600SemiBold } from '@expo-google-fonts/albert-sans';
import { APP_VERSION, type Me } from '@bmu/shared';
import { api, onSessionExpired, session } from './src/api';
import { stopLive } from './src/live';
import { SignInScreen } from './src/SignInScreen';
import { ClientBilling, ClientFiles, ClientHome, ClientMessages, ClientRequests, ClientReviews } from './src/screens/client';
import { NotificationsScreen } from './src/screens/shared';
import { ContentCalendar, TeamCalendar } from './src/screens/calendars';
import { Inbox, isClientTeam, MyDay, Tasks, TeamMessages } from './src/screens/team';
import { isFounderView, Pulse } from './src/screens/pulse';
import { fonts, ui } from './src/theme';
import { QuickAdd } from './src/screens/core-actions';
import { ClientQuickAdd } from './src/screens/ops-actions';
import { Body, Button, Muted, Row, Screen, Title } from './src/ui';
import { cache, startOffline, syncNow } from './src/offline';
import { listenForPush, registerPush, unregisterPush } from './src/push';
import { LockScreen, useLock } from './src/lock';

/** Opens the screen for a notification's web link (falls back to Notifications). */
function routeFor(link: string | null, client: boolean): [string, string | undefined] {
  const id = (k: string) => link?.match(new RegExp(`/${k}/([\\w-]+)`))?.[1];
  if (!link) return ['more', 'notifications'];
  // v34: post published / post due notifications open the content calendar.
  if (link.includes('/calendar') || link.includes('/content-calendar')) return ['more', 'content'];
  if (client) {
    if (link.includes('/reviews')) return ['reviews', id('reviews')];
    if (link.includes('/requests')) return ['requests', id('requests')];
    if (link.includes('/messages')) return ['messages', undefined];
    return ['more', 'notifications'];
  }
  if (link.includes('/tasks')) return ['tasks', undefined];
  if (link.includes('/requests')) return ['requests', id('requests')];
  if (link.includes('/messages')) return ['messages', id('messages')];
  return ['more', 'notifications'];
}

type Tab = { key: string; label: string };

export default function App() {
  const [fontsLoaded] = useFonts({ ZenDots_400Regular, AlbertSans_400Regular, AlbertSans_600SemiBold });
  const [me, setMe] = useState<Me | null>();
  const [tab, setTab] = useState('home');
  const [detail, setDetail] = useState<string>();
  const [unread, setUnread] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [version, setVersion] = useState(0);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const lock = useLock(!!me);
  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(undefined), 5000);
  };

  // v20: offline outbox, push registration and quick actions once signed in.
  useEffect(() => {
    if (!me) return;
    startOffline();
    void registerPush().then(setPushNote);
    return listenForPush(
      (link) => {
        const [t, id] = routeFor(link, me.type === 'client');
        setTab(t);
        setDetail(id);
      },
      (m) => {
        flash(m);
        setVersion((v) => v + 1);
      },
    );
  }, [me]);

  // A 401 from any screen means the session ended: go back to sign-in instead of showing errors everywhere.
  useEffect(
    () =>
      onSessionExpired(() => {
        stopLive();
        setMe(null);
        setTab('home');
        setDetail(undefined);
        setNotice('Your session has ended. Sign in again to carry on.');
      }),
    [],
  );

  // Restore a saved session on launch.
  useEffect(() => {
    session
      .load()
      .then((token) => (token ? api.auth.me() : null))
      .then((m) => {
        if (m && isFounderView(m)) setTab('pulse');
        setMe(m);
      })
      .catch(() => session.clear().then(() => setMe(null)));
  }, []);

  // Unread notifications badge, refreshed every 30 seconds.
  useEffect(() => {
    if (!me) return;
    const tick = () => api.notifications.list().then((n) => setUnread(n.unread), () => undefined);
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [me, tab]);

  if (!fontsLoaded || me === undefined) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={ui.ink} />
      </View>
    );
  }

  const go = (t: string, id?: string) => {
    setTab(t);
    setDetail(id);
  };
  const signOut = async () => {
    await syncNow();
    await unregisterPush();
    await api.auth.logout().catch(() => undefined);
    await cache.clear();
    stopLive();
    await session.clear();
    setMe(null);
    go('home');
  };

  const isClient = me?.type === 'client';
  const tabs: Tab[] = !me
    ? []
    : isClient
      ? [
          { key: 'home', label: 'Home' },
          { key: 'reviews', label: 'Reviews' },
          { key: 'requests', label: 'Requests' },
          { key: 'messages', label: 'Messages' },
          { key: 'more', label: 'More' },
        ]
      : [
          ...(isFounderView(me) ? [{ key: 'pulse', label: 'Pulse' }] : []),
          { key: 'home', label: 'My Day' },
          { key: 'tasks', label: 'Tasks' },
          ...(isClientTeam(me) ? [{ key: 'requests', label: 'Requests' }, { key: 'messages', label: 'Messages' }] : []),
          { key: 'more', label: 'More' },
        ];

  function content() {
    if (!me) return <SignInScreen notice={notice} onSignedIn={(m) => (setMe(m), setNotice(undefined), go(isFounderView(m) ? 'pulse' : 'home'))} />;
    if (tab === 'more') {
      if (detail === 'notifications') return <NotificationsScreen />;
      if (detail === 'billing') return <ClientBilling onBack={() => go('more')} />;
      if (detail === 'files') return <ClientFiles onBack={() => go('more')} />;
      // v34: calendars on the phone.
      if (detail === 'calendar' && !isClient) return <TeamCalendar onBack={() => go('more')} />;
      if (detail === 'content') return <ContentCalendar client={isClient} onBack={() => go('more')} />;
      return (
        <Screen>
          <Title sub={me.clientOrg?.name ?? me.roles.join(', ').replaceAll('_', ' ')}>{me.name}</Title>
          <Row title="Notifications" sub={unread ? `${unread} unread` : 'All caught up'} onPress={() => go('more', 'notifications')} />
          {!isClient && <Row title="Calendar" sub="Deadlines, meetings, social posts, leave and holidays" onPress={() => go('more', 'calendar')} />}
          <Row title="Content calendar" sub={isClient ? 'Your scheduled and published posts' : 'Scheduled and published social posts'} onPress={() => go('more', 'content')} />
          {isClient && <Row title="Billing" sub="Invoices and payments" onPress={() => go('more', 'billing')} />}
          {isClient && <Row title="Files" sub="Approved work and final delivery" onPress={() => go('more', 'files')} />}
          {!isClient && <Row title="Full workspace" sub="Projects, QC, Review Studio and the Command Centre are on the website" />}
          <Row
            title="App lock"
            sub={lock.enabled ? 'On: Face ID, fingerprint or passcode to open' : 'Off'}
            right={<Body>{lock.enabled ? 'Turn off' : 'Turn on'}</Body>}
            onPress={() => void lock.toggle().then((m) => m && flash(m))}
          />
          <Row title="Push notifications" sub={pushNote ?? 'On, with Approve, Reply, Done and Snooze on the notification'} />
          <Row title="Works offline" sub="Recent screens open without signal; task changes sync when you are back online" />
          <Button variant="secondary" title="Sign out" onPress={signOut} />
          <Muted style={{ marginTop: 24, textAlign: 'center' }}>BMU Hub {APP_VERSION}</Muted>
        </Screen>
      );
    }
    if (isClient) {
      if (tab === 'reviews') return <ClientReviews id={detail} go={go} />;
      if (tab === 'requests') return <ClientRequests id={detail} go={go} />;
      if (tab === 'messages') return <ClientMessages />;
      return <ClientHome name={me.name} go={go} />;
    }
    if (tab === 'pulse' && isFounderView(me)) return <Pulse me={me} />;
    if (tab === 'tasks') return <Tasks version={version} />;
    if (tab === 'requests') return <Inbox id={detail} open={(id) => go('requests', id)} />;
    if (tab === 'messages') return <TeamMessages id={detail} open={(id) => go('messages', id)} />;
    return <MyDay me={me} />;
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <StatusBar style="dark" />
        <View style={styles.header}>
          <Text style={styles.logo}>
            BMU<Text style={{ color: ui.accent }}>.</Text>
          </Text>
          {me ? (
            <Pressable onPress={() => go('more', 'notifications')} hitSlop={10} style={styles.bell}>
              <Body>🔔</Body>
              {unread > 0 && <Text style={styles.dot}>{unread > 9 ? '9+' : unread}</Text>}
            </Pressable>
          ) : (
            <Muted>Hub</Muted>
          )}
        </View>
        <View style={{ flex: 1 }}>
          {content()}
          {/* v11 core: quick add on every team tab. */}
          {me && me.type === 'staff' && (
            <QuickAdd
              me={me}
              onDone={(m) => {
                setToast(m);
                setVersion((v) => v + 1);
                setTimeout(() => setToast(undefined), 5000);
              }}
            />
          )}
          {/* v11 ops: the client's floating + (Request, Photo or video) on every client tab. */}
          {me && me.type === 'client' && (
            <ClientQuickAdd
              onDone={(m) => {
                setToast(m);
                setVersion((v) => v + 1);
                setTimeout(() => setToast(undefined), 5000);
              }}
            />
          )}
          {toast ? (
            <Pressable onPress={() => setToast(undefined)} style={styles.toast}>
              <Text style={styles.toastText}>{toast}</Text>
            </Pressable>
          ) : null}
        </View>
        {lock.locked ? <LockScreen onUnlock={lock.unlock} /> : null}
        {me && !lock.locked && (
          <View style={styles.tabs}>
            {tabs.map((t) => (
              <Pressable key={t.key} onPress={() => go(t.key)} style={styles.tab}>
                <View style={[styles.tabMark, tab === t.key && { backgroundColor: ui.accent }]} />
                <Text style={[styles.tabText, tab === t.key && { color: ui.ink, fontFamily: fonts.bodyBold }]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: { paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: ui.line },
  logo: { fontFamily: fonts.display, fontSize: 20, color: ui.ink },
  bell: { padding: 4 },
  dot: { position: 'absolute', top: -4, right: -8, backgroundColor: ui.bad, color: '#fff', fontSize: 10, paddingHorizontal: 4, borderRadius: 8, overflow: 'hidden', fontFamily: fonts.bodyBold },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: ui.line, backgroundColor: ui.bg },
  tab: { flex: 1, alignItems: 'center', paddingTop: 0, paddingBottom: 10 },
  tabMark: { height: 2, alignSelf: 'stretch', marginBottom: 8 },
  tabText: { fontFamily: fonts.body, fontSize: 12, color: ui.muted },
  toast: { position: 'absolute', left: 16, right: 88, bottom: 16, backgroundColor: ui.ink, padding: 12 },
  toastText: { fontFamily: fonts.body, color: '#fff', fontSize: 14 },
});
