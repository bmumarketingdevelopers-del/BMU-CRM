import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { ThreadView } from '@bmu/shared';
import { api } from '../api';
import { fonts, ui } from '../theme';
import { Badge, Body, Button, Card, Empty, ErrorText, Input, Loading, Muted, Screen, Title, useData, when } from '../ui';

export function NotificationsScreen() {
  const n = useData(() => api.notifications.list(), [], { cacheKey: 'notifications' });
  return (
    <Screen refreshing={n.refreshing} onRefresh={n.refresh}>
      <Title sub={n.data ? `${n.data.unread} unread` : undefined}>Notifications</Title>
      {!n.data ? <Loading /> : null}
      {n.data && n.data.unread > 0 && <Button variant="secondary" title="Mark all read" onPress={() => api.notifications.read('all').then(n.setData)} />}
      <View style={{ marginTop: 12 }}>
        {n.data?.items.map((i) => (
          <Card key={i.id} tone={!i.read && i.critical ? 'bad' : !i.read ? 'good' : undefined} onPress={() => api.notifications.read([i.id]).then(n.setData)}>
            <Body bold={!i.read}>{i.title}</Body>
            {i.body ? <Muted style={{ marginTop: 4 }}>{i.body}</Muted> : null}
            <Muted style={{ marginTop: 6, fontSize: 11 }}>{when(i.at)}</Muted>
          </Card>
        ))}
        {n.data?.items.length === 0 && <Empty>You&apos;re all caught up.</Empty>}
      </View>
      <ErrorText>{n.error}</ErrorText>
    </Screen>
  );
}

/** Client ↔ AM conversation. Internal notes show only on the team side. */
export function ChatView({ thread, allowInternal, onSend, title, sub }: { thread: ThreadView; allowInternal?: boolean; onSend: (body: string, internal: boolean) => Promise<void>; title: string; sub?: string }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function send() {
    if (!body.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSend(body.trim(), internal);
      setBody('');
      setInternal(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Title sub={sub}>{title}</Title>
      {thread.messages.map((m) => (
        <View key={m.id} style={{ alignItems: m.mine ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
          <View
            style={{
              maxWidth: '85%',
              padding: 12,
              backgroundColor: m.internal ? '#F2D27A33' : m.mine ? ui.ink : m.isClient ? '#8BB72C22' : ui.soft,
              borderWidth: m.internal ? 1 : 0,
              borderStyle: 'dashed',
              borderColor: ui.warn,
            }}
          >
            <Text style={{ fontFamily: fonts.body, fontSize: 15, color: m.mine && !m.internal ? '#fff' : ui.ink }}>{m.body}</Text>
            <Text style={{ fontFamily: fonts.body, fontSize: 11, marginTop: 4, color: m.mine && !m.internal ? '#C2C2C2' : ui.muted }}>
              {m.internal ? '🔒 Internal · ' : ''}
              {m.author} · {when(m.at)}
            </Text>
          </View>
        </View>
      ))}
      {thread.messages.length === 0 && <Empty>No messages yet. Say hello.</Empty>}
      <Input value={body} onChangeText={setBody} placeholder={internal ? 'Internal note for the team' : 'Write a message'} multiline />
      {allowInternal && (
        <Pressable onPress={() => setInternal((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <Badge tone={internal ? 'warn' : 'neutral'}>{internal ? '🔒 Internal note: client never sees it' : 'Visible to the client'}</Badge>
          <Muted>tap to switch</Muted>
        </Pressable>
      )}
      <Button title="Send" onPress={send} busy={busy} disabled={!body.trim()} />
      <ErrorText>{error}</ErrorText>
    </>
  );
}
