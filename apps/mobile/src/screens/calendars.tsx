// v34: the team Calendar and the Content calendar on the phone, as day-by-day lists (a month grid is too small to
// read on a phone). Both refresh on their own when records change (useData listens to live updates) and on pull-down.
import { useState } from 'react';
import { Text, View } from 'react-native';
import { deliverChannelLabels, type CalendarItem, type CalendarItemKind, type DeliverCalendarItem } from '@bmu/shared';
import { api } from '../api';
import { Back, Badge, Body, Button, Card, Empty, ErrorText, Loading, Muted, Pills, Screen, Section, Title, useData, s } from '../ui';

const KIND: Record<CalendarItemKind, string> = {
  task: 'Task',
  deliverable: 'Deliverable due',
  draft_due: 'First drafts due',
  meeting: 'Meeting',
  post: 'Social post',
  leave: 'Leave',
  holiday: 'Holiday',
};
const istNow = () => new Date(Date.now() + 330 * 60_000);
const thisMonth = () => istNow().toISOString().slice(0, 7);
const shiftMonth = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
};
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayName = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const ymdIst = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

function MonthBar({ month, setMonth }: { month: string; setMonth: (m: string) => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
      <Button variant="secondary" title="←" onPress={() => setMonth(shiftMonth(month, -1))} />
      <Body bold>{monthName(month)}</Body>
      <Button variant="secondary" title="→" onPress={() => setMonth(shiftMonth(month, 1))} />
    </View>
  );
}

/** Groups items by day, today and later first, then the earlier days of the month. */
function byDay<T>(items: T[], dayOf: (t: T) => string, today: string) {
  const map = new Map<string, T[]>();
  for (const i of items) map.set(dayOf(i), [...(map.get(dayOf(i)) ?? []), i]);
  const days = [...map.keys()].sort();
  return [...days.filter((d) => d >= today), ...days.filter((d) => d < today)].map((d) => [d, map.get(d)!] as const);
}

export function TeamCalendar({ onBack }: { onBack: () => void }) {
  const [month, setMonth] = useState(thisMonth());
  const [view, setView] = useState<'mine' | 'team'>('mine');
  const d = useData(() => api.workspace.calendar(month, view), [month, view], { cacheKey: `calendar:${month}:${view}` });
  const today = istNow().toISOString().slice(0, 10);
  return (
    <Screen refreshing={d.refreshing} onRefresh={d.refresh}>
      <Back onPress={onBack} />
      <Title sub="Deadlines, meetings, social posts, leave and holidays. Times are IST.">Calendar</Title>
      <Pills value={view} onChange={setView} options={[{ value: 'mine', label: 'Mine' }, { value: 'team', label: 'My team' }]} />
      <MonthBar month={month} setMonth={setMonth} />
      <ErrorText>{d.error}</ErrorText>
      {!d.data || d.data.month !== month ? (
        <Loading />
      ) : d.data.items.length === 0 ? (
        <Empty>Nothing in {monthName(month)}.</Empty>
      ) : (
        byDay<CalendarItem>(d.data.items, (i) => i.date, today).map(([date, list]) => (
          <View key={date}>
            <Section>{date === today ? `Today · ${dayName(date)}` : dayName(date)}</Section>
            {list.map((i) => (
              <Card key={i.id} tone={i.overdue ? 'bad' : undefined}>
                <Text style={[s.text, { fontWeight: '600', textDecorationLine: i.done ? 'line-through' : 'none' }]}>
                  {i.time ? `${i.time}  ` : ''}
                  {i.title}
                </Text>
                <Muted>
                  {KIND[i.kind]}
                  {i.sub ? ` · ${i.sub}` : ''}
                  {i.overdue ? ' · overdue' : ''}
                </Muted>
              </Card>
            ))}
          </View>
        ))
      )}
    </Screen>
  );
}

const STATUS: Record<string, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' }> = {
  scheduled: { label: 'Scheduled', tone: 'neutral' },
  published: { label: 'Live', tone: 'good' },
};

export function ContentCalendar({ onBack, client }: { onBack: () => void; client: boolean }) {
  const [month, setMonth] = useState(thisMonth());
  const from = `${month}-01T00:00:00+05:30`;
  const to = `${shiftMonth(month, 1)}-01T00:00:00+05:30`;
  const d = useData(() => (client ? api.deliver.clientCalendar(from, to) : api.deliver.calendar(from, to)), [month, client], { cacheKey: `content:${client ? 'c' : 't'}:${month}` });
  const today = istNow().toISOString().slice(0, 10);
  const items = (d.data?.items ?? []).filter((i) => i.scheduledAt || i.publishedAt);
  const due = d.data?.dueToPublish ?? [];
  const row = (i: DeliverCalendarItem) => {
    const at = i.scheduledAt ?? i.publishedAt!;
    const st = due.some((x) => x.deliverableId === i.deliverableId) ? { label: 'Due to post', tone: 'bad' as const } : (STATUS[i.status] ?? { label: i.status, tone: 'neutral' as const });
    return (
      <Card key={i.deliverableId}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <Text style={[s.text, { fontWeight: '600', flex: 1 }]}>
            {hhmm(at)}  {i.title}
          </Text>
          <Badge tone={st.tone}>{st.label}</Badge>
        </View>
        <Muted>{[client ? null : i.client.name, i.channel ? deliverChannelLabels[i.channel] : null, i.caption ? i.caption.slice(0, 80) : null].filter(Boolean).join(' · ')}</Muted>
      </Card>
    );
  };
  return (
    <Screen refreshing={d.refreshing} onRefresh={d.refresh}>
      <Back onPress={onBack} />
      <Title sub={client ? 'Your scheduled and published posts. Times are IST.' : 'Scheduled and published social posts. Schedule and drag posts on the website.'}>Content calendar</Title>
      <MonthBar month={month} setMonth={setMonth} />
      <ErrorText>{d.error}</ErrorText>
      {!client && due.length > 0 && (
        <Card tone="bad">
          <Body bold>{due.length} post{due.length === 1 ? '' : 's'} past their time, not marked published</Body>
          <Muted>{due.map((x) => x.title).slice(0, 3).join(', ')}</Muted>
        </Card>
      )}
      {!client && (d.data?.unscheduled.length ?? 0) > 0 && <Muted style={{ marginBottom: 8 }}>{d.data!.unscheduled.length} approved post(s) waiting for a date.</Muted>}
      {!d.data ? <Loading /> : items.length === 0 ? <Empty>No posts in {monthName(month)}.</Empty> : byDay(items, (i) => ymdIst(i.scheduledAt ?? i.publishedAt!), today).map(([date, list]) => (
        <View key={date}>
          <Section>{date === today ? `Today · ${dayName(date)}` : dayName(date)}</Section>
          {list.map(row)}
        </View>
      ))}
    </Screen>
  );
}
