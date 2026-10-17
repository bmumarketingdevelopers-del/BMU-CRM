import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { isCraftManager, isCraftSpecialty, requestStatusLabels, syncStatusLabels, withPending, requestTypeLabels, taskStatusLabels, type Me, type RequestView, type TaskView } from '@bmu/shared';
import { api } from '../api';
import { Back, Badge, Body, Button, Card, Empty, ErrorText, Input, Loading, Muted, OfflineBanner, Pills, Row, Screen, Section, Stats, Title, day, useData, when } from '../ui';
import { editTask, useSync } from '../offline';
import { ChatView } from './shared';
import { CraftSummary, ManagerToday } from './craft';
import { TaskActionButtons } from './core-actions';

const hasRole = (me: Me, roles: string[]) => me.roles.some((r) => roles.includes(r));
export const isClientTeam = (me: Me) => hasRole(me, ['founder', 'admin', 'am_lead', 'account_manager']);

// ---------------------------------------------------------------------------

function TaskCard({ t: shown, onChange, actions }: { t: TaskView; onChange: () => void; actions?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // v20: status changes go through the offline outbox, show at once, and sync when there is signal.
  const sync = useSync();
  const t = withPending(shown, sync.ops);
  async function set(status: TaskView['status']) {
    setBusy(true);
    setError(undefined);
    try {
      const results = await editTask(shown, { status });
      const mine = results.find((r) => r.task?.id === shown.id || (r.status === 'rejected' && !r.task));
      if (mine && (mine.status === 'rejected' || mine.status === 'conflict')) setError(mine.message ?? syncStatusLabels[mine.status]);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card tone={t.overdue ? 'bad' : t.status === 'blocked' ? 'warn' : undefined}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Body bold style={{ flex: 1 }}>
          {t.title}
        </Body>
        <Badge tone={t.status === 'done' ? 'good' : t.status === 'blocked' ? 'warn' : 'neutral'}>{taskStatusLabels[t.status]}</Badge>
      </View>
      {t.pendingSync ? <Muted style={{ marginTop: 4 }}>Waiting to sync</Muted> : null}
      <Muted style={{ marginTop: 4 }}>
        {[t.client?.name, t.deadline ? `Due ${day(t.deadline)}` : null, !t.ready ? 'Waiting on previous step' : null].filter(Boolean).join(' · ')}
      </Muted>
      {t.blockedReason ? <Muted>Blocked: {t.blockedReason}</Muted> : null}
      {t.kind === 'work' || t.kind === 'planning' ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(t.status === 'todo' || t.status === 'blocked') && t.ready && (
            <View style={{ flex: 1 }}>
              <Button variant="secondary" title={t.status === 'todo' ? 'Start' : 'Resume'} busy={busy} onPress={() => set('in_progress')} />
            </View>
          )}
          {t.status === 'in_progress' && !t.deliverable && (
            <View style={{ flex: 1 }}>
              <Button title="Mark done" busy={busy} onPress={() => set('done')} />
            </View>
          )}
        </View>
      ) : null}
      {t.status === 'in_progress' && t.deliverable ? <Muted style={{ marginTop: 6 }}>Upload the version on the website to finish this step.</Muted> : null}
      {actions}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

export function MyDay({ me }: { me: Me }) {
  const d = useData(() => api.myDay.get(), [], { cacheKey: 'myday' });
  const [busy, setBusy] = useState(false);
  const day0 = d.data;
  async function check(out: boolean) {
    setBusy(true);
    try {
      d.setData(await (out ? api.myDay.checkOut() : api.myDay.checkIn()));
    } finally {
      setBusy(false);
    }
  }
  if (!day0) return <Screen><Loading /><ErrorText>{d.error}</ErrorText></Screen>;
  const t = day0.tasks;
  return (
    <Screen refreshing={d.refreshing} onRefresh={d.refresh}>
      <Title sub={me.roles.join(', ').replaceAll('_', ' ')}>Hello, {me.name.split(' ')[0]}</Title>
      <OfflineBanner savedAt={d.savedAt} />
      <Card tone={day0.checkIn && !day0.checkOut ? 'good' : undefined}>
        <Body bold>
          {!day0.checkIn
            ? day0.workday && day0.workday.kind !== 'working'
              ? `${day0.workday.kind === 'holiday' ? `Holiday${day0.workday.label ? `: ${day0.workday.label}` : ''}` : 'Weekly off'}. No check-in today.`
              : 'Not checked in yet'
            : day0.checkOut
              ? `Checked out at ${when(day0.checkOut)}`
              : `Checked in at ${when(day0.checkIn)}`}
        </Body>
        {day0.nextCheckIn && (day0.checkOut || !day0.canCheckIn) ? <Body>Check-in opens on {day0.nextCheckIn}.</Body> : null}
        {(day0.canCheckIn ?? !day0.checkIn) && <Button title="Check in" busy={busy} onPress={() => check(false)} />}
        {day0.checkIn && !day0.checkOut && <Button variant="secondary" title="Check out" busy={busy} onPress={() => check(true)} />}
      </Card>
      <Stats
        items={[
          { label: 'Overdue', value: t.overdue.length, tone: t.overdue.length ? 'bad' : undefined },
          { label: 'Due today', value: t.today.length },
          { label: 'Blocked', value: t.blocked.length, tone: t.blocked.length ? 'warn' : undefined },
          { label: 'QC waiting', value: day0.qcWaiting },
        ]}
      />
      {/* v10 craft: specialists see their workspace headline; managers see Today and can reassign. */}
      {isCraftSpecialty(me.specialty) ? <CraftSummary /> : isCraftManager(me) ? <ManagerToday /> : null}
      {[
        ['Overdue', t.overdue],
        ['Today', t.today],
        ['Blocked', t.blocked],
        ['Coming up', t.upcoming],
      ].map(([label, list]) =>
        (list as TaskView[]).length ? (
          <View key={label as string}>
            <Section>{label as string}</Section>
            {(list as TaskView[]).map((x) => (
              <TaskCard key={x.id} t={x} onChange={d.reload} />
            ))}
          </View>
        ) : null,
      )}
      {!t.overdue.length && !t.today.length && !t.blocked.length && !t.upcoming.length && <Empty>No tasks on your plate.</Empty>}
      {day0.eod.submitted ? <Muted style={{ marginTop: 16 }}>End-of-day report submitted ✓</Muted> : <Muted style={{ marginTop: 16 }}>Submit your end-of-day report on the website.</Muted>}
    </Screen>
  );
}

export function Tasks({ version = 0 }: { version?: number }) {
  const [view, setView] = useState<'mine' | 'team'>('mine');
  const [notice, setNotice] = useState<string>();
  // v11 core: rows carry what the person may do (reassign, change or request a deadline).
  const list = useData(() => api.coreTasks.query({ scope: view }), [view, version], { cacheKey: `tasks:${view}` });
  const sync = useSync();
  // Reload once queued edits have synced (for example when the phone comes back online).
  const reload = list.reload;
  useEffect(() => {
    if (sync.last?.length) void reload();
  }, [sync.last, reload]);
  const open = (list.data ?? []).filter((t) => !['done', 'cancelled'].includes(t.status));
  const refresh = async () => {
    await sync.syncNow();
    await list.refresh();
  };
  return (
    <Screen refreshing={list.refreshing} onRefresh={refresh}>
      <Title sub={`${open.length} open`}>Tasks</Title>
      <OfflineBanner savedAt={list.savedAt} pending={sync.pending} online={sync.online} />
      {sync.problems.map((p) => (
        <Muted key={p.clientOpId} style={{ marginBottom: 6 }}>
          {p.task?.title ?? 'A task'}: {p.message ?? syncStatusLabels[p.status]}
        </Muted>
      ))}
      <Pills value={view} onChange={setView} options={[{ value: 'mine', label: 'Mine' }, { value: 'team', label: 'Team' }]} />
      {notice ? <Muted style={{ marginBottom: 8 }}>{notice}</Muted> : null}
      {!list.data && <Loading />}
      {open.map((t) => (
        <TaskCard key={t.id} t={t} onChange={list.reload} actions={<TaskActionButtons t={t} onDone={(m) => (setNotice(m), list.reload())} />} />
      ))}
      {list.data && open.length === 0 && <Empty>Nothing open.</Empty>}
      <ErrorText>{list.error}</ErrorText>
    </Screen>
  );
}

// ---------------------------------------------------------------------------

const sla = (r: RequestView) =>
  r.sla.state === 'overdue' ? <Badge tone="bad">Reply overdue</Badge> : r.sla.state === 'due' ? <Badge tone="warn">{`Reply in ${Math.max(0, Math.round((r.sla.workingMinutesLeft ?? 0) / 60))}h`}</Badge> : undefined;

export function Inbox({ id, open }: { id?: string; open: (id?: string) => void }) {
  if (id) return <RequestDetail id={id} onBack={() => open()} />;
  return <InboxList open={open} />;
}

function InboxList({ open }: { open: (id?: string) => void }) {
  const list = useData(() => api.requests.list(), [], { cacheKey: 'requests' });
  const rows = (list.data ?? []).filter((r) => !['done', 'declined'].includes(r.status));
  return (
    <Screen refreshing={list.refreshing} onRefresh={list.refresh}>
      <Title sub="First replies are counted in working hours.">Requests</Title>
      {!list.data && !list.error && <Loading />}
      {rows.map((r) => (
        <Row key={r.id} title={r.description} sub={`${r.client.name} · ${requestTypeLabels[r.type].team} · ${requestStatusLabels[r.status].team}`} right={sla(r)} onPress={() => open(r.id)} />
      ))}
      {list.data && rows.length === 0 && <Empty>No open requests.</Empty>}
      <ErrorText>{list.error}</ErrorText>
    </Screen>
  );
}

function RequestDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const d = useData(() => api.requests.get(id), [id], { cacheKey: `request:${id}` });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const r = d.data;
  async function decide(input: Parameters<typeof api.requests.decide>[1]) {
    setBusy(true);
    setError(undefined);
    try {
      d.setData(await api.requests.decide(id, input));
      setMessage('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!r) return <Screen><Back onPress={onBack} /><Loading /><ErrorText>{d.error}</ErrorText></Screen>;
  const msg = message.trim() || undefined;
  const undecided = ['received', 'scope_check', 'rescheduled'].includes(r.status);
  return (
    <Screen refreshing={d.refreshing} onRefresh={d.refresh}>
      <Back onPress={onBack} label="Requests" />
      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
        <Badge tone="dark">{requestStatusLabels[r.status].team}</Badge>
        {sla(r)}
      </View>
      <Title sub={`${r.client.name} · ${requestTypeLabels[r.type].team} · by ${r.createdBy}`}>{r.description}</Title>
      {r.quote && (
        <Card>
          <Body bold>Quote sent</Body>
          <Muted>Waiting for the client owner to approve and pay.</Muted>
        </Card>
      )}
      <Section>Conversation</Section>
      {r.comments.map((c) => (
        <Card key={c.id} tone={c.internal ? 'warn' : c.isClient ? 'good' : undefined}>
          <Muted>
            {c.author}
            {c.internal ? ' · 🔒 Internal' : ''} · {when(c.at)}
          </Muted>
          <Body style={{ marginTop: 4 }}>{c.body}</Body>
        </Card>
      ))}
      {r.comments.length === 0 && <Muted>No replies yet.</Muted>}
      <Input value={message} onChangeText={setMessage} placeholder="Reply to the client" multiline />
      <Button title="Reply" busy={busy} disabled={!msg} onPress={() => decide({ action: 'reply', message, internal: false })} />
      <Button variant="secondary" title="Add internal note" busy={busy} disabled={!msg} onPress={() => decide({ action: 'reply', message, internal: true })} />
      {r.can.decide && (
        <>
          <Section>Decide</Section>
          {r.type === 'urgent' && undecided && <Button variant="accent" title="Accept urgent request" busy={busy} onPress={() => decide({ action: 'accept_urgent', message: msg })} />}
          {r.type !== 'urgent' && r.type !== 'new_scope' && undecided && <Button variant="accent" title="In scope: start work" busy={busy} onPress={() => decide({ action: 'in_scope', message: msg })} />}
          {['in_progress', 'paid'].includes(r.status) && <Button title="Mark done" busy={busy} onPress={() => decide({ action: 'done', message: msg })} />}
          {r.type === 'new_scope' && undecided && <Muted style={{ marginTop: 8 }}>Send the quote from the website: pick the add-on and timeline there.</Muted>}
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}

// ---------------------------------------------------------------------------

export function TeamMessages({ id, open }: { id?: string; open: (id?: string) => void }) {
  const list = useData(() => api.threads.list(), [], { cacheKey: 'threads' });
  const t = useData(() => (id ? api.threads.get(id) : Promise.resolve(undefined)), [id], { cacheKey: id ? `thread:${id}` : undefined });
  if (id) {
    if (!t.data) return <Screen><Back onPress={() => open()} /><Loading /><ErrorText>{t.error}</ErrorText></Screen>;
    return (
      <Screen refreshing={t.refreshing} onRefresh={t.refresh}>
        <Back onPress={() => (open(), list.reload())} label="Messages" />
        <ChatView thread={t.data} allowInternal title={t.data.client.name} sub={t.data.awaitingReply ? `Reply by ${when(t.data.awaitingReply.due)}` : undefined} onSend={async (b, internal) => t.setData(await api.threads.send(id, b, internal))} />
      </Screen>
    );
  }
  return (
    <Screen refreshing={list.refreshing} onRefresh={list.refresh}>
      <Title sub="Reply the same working day.">Messages</Title>
      {!list.data && !list.error && <Loading />}
      {list.data?.map((x) => (
        <Row
          key={x.id}
          title={x.client.name}
          sub={x.lastMessage ? `${x.lastMessage.author}: ${x.lastMessage.body}` : 'No messages yet'}
          right={x.awaitingReply ? <Badge tone={x.awaitingReply.overdue ? 'bad' : 'warn'}>{x.awaitingReply.overdue ? 'Overdue' : 'Reply'}</Badge> : undefined}
          onPress={() => open(x.id)}
        />
      ))}
      {list.data?.length === 0 && <Empty>No client conversations yet.</Empty>}
      <ErrorText>{list.error}</ErrorText>
    </Screen>
  );
}
