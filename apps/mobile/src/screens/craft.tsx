// v10 craft on the phone: a specialist's top KPIs and next actions, and a manager's "Today" with reassign.
import { useState } from 'react';
import { View } from 'react-native';
import { craftSpecialtyLabel, type CraftBoardTask, type CraftKpi, type CraftManagerView } from '@bmu/shared';
import { api } from '../api';
import { Badge, Body, Button, Card, Empty, ErrorText, Loading, Muted, Row, Section, Stats, day, useData } from '../ui';

const fmt = (k: CraftKpi) => (k.format === 'pct' ? `${Math.round(k.value)}%` : k.format === 'hours' ? `${k.value}h` : k.format === 'days' ? `${k.value}d` : String(k.value));
const nextTone = { overdue: 'bad', due_today: 'warn', assigned: 'good', feedback: 'dark', blocked: 'bad' } as const;
const nextLabel = { overdue: 'Overdue', due_today: 'Today', assigned: 'New', feedback: 'Feedback', blocked: 'Blocked' } as const;

/** Specialist workspace summary: the four headline KPIs and what to do next. */
export function CraftSummary() {
  const { data: d, error } = useData(() => api.craft.dashboard(), [], { cacheKey: 'craft' });
  if (!d) return error ? <ErrorText>{error}</ErrorText> : <Loading />;
  return (
    <View>
      <Section>{d.person.specialtyLabel || 'Your work'} · last 30 days</Section>
      <Stats items={d.kpis.slice(0, 4).map((k) => ({ label: k.label, value: fmt(k), tone: k.lowerIsBetter && k.value > 0 && k.previous !== null && k.value > k.previous ? 'warn' : undefined }))} />
      <Section>What to do next</Section>
      {d.next.length ? (
        d.next.slice(0, 8).map((n) => <Row key={n.id} title={n.title} sub={`${n.client ? `${n.client} · ` : ''}${n.detail}`} right={<Badge tone={nextTone[n.kind]}>{nextLabel[n.kind]}</Badge>} />)
      ) : (
        <Empty>Nothing urgent. Nice work.</Empty>
      )}
      {d.insights[0] ? <Muted style={{ marginTop: 8 }}>{d.insights[0]}</Muted> : null}
    </View>
  );
}

/** Manager "Today" plus the tasks that need an owner, each reassignable with a picker. */
export function ManagerToday() {
  const { data: v, error, reload } = useData(() => api.craftManager.view(), [], { cacheKey: 'craft:manager' });
  if (!v) return error ? <ErrorText>{error}</ErrorText> : <Loading />;
  const needs = v.board.filter((t) => !t.owner || t.overdue || t.status === 'blocked').slice(0, 10);
  return (
    <View>
      <Stats items={v.kpis.slice(0, 4).map((k) => ({ label: k.label, value: fmt(k), tone: k.lowerIsBetter && k.value > 0 ? 'warn' : undefined }))} />
      <Section>Today</Section>
      {v.today.length ? (
        v.today.slice(0, 10).map((t) => <Row key={t.id} title={t.title} sub={`${t.client ? `${t.client} · ` : ''}${t.detail}`} right={<Badge tone={['blocked', 'overdue', 'qc_failed'].includes(t.kind) ? 'bad' : t.kind === 'client_reply' ? 'warn' : 'neutral'}>{t.kind.replace('_', ' ')}</Badge>} />)
      ) : (
        <Empty>Nothing needs you right now.</Empty>
      )}
      <Section>Assign or reassign</Section>
      {needs.length ? needs.map((t) => <AssignCard key={t.id} t={t} v={v} onDone={reload} />) : <Empty>Every task has an owner and nothing is late.</Empty>}
    </View>
  );
}

function AssignCard({ t, v, onDone }: { t: CraftBoardTask; v: CraftManagerView; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  async function assign(ownerId: string, name: string) {
    setBusy(ownerId);
    setError(undefined);
    try {
      await api.craftManager.assign(t.id, { ownerId });
      setDone(`Assigned to ${name}`);
      setOpen(false);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }
  const people = v.members.filter((m) => m.id !== t.owner?.id && !t.cannotAssignTo.includes(m.id) && !m.onLeaveToday);
  return (
    <Card tone={t.overdue || t.status === 'blocked' ? 'bad' : !t.owner ? 'warn' : undefined}>
      <Body bold>{t.title}</Body>
      <Muted>
        {t.client?.name ?? 'Internal'} · {t.deadline ? `due ${day(t.deadline)}` : 'no date'} · {t.owner ? `with ${t.owner.name}` : 'no owner'}
        {t.specialty ? ` · ${craftSpecialtyLabel(t.specialty)}` : ''}
      </Muted>
      {done ? <Muted>✓ {done}</Muted> : null}
      {t.suggestion && !done ? <Button variant="accent" title={`Assign to ${t.suggestion.name}`} busy={busy === t.suggestion.userId} onPress={() => assign(t.suggestion!.userId, t.suggestion!.name)} /> : null}
      {!done ? <Button variant="secondary" title={open ? 'Close' : t.owner ? 'Reassign…' : 'Pick someone…'} onPress={() => setOpen((o) => !o)} /> : null}
      {open &&
        people.map((m) => (
          <Row key={m.id} title={m.name} sub={`${m.specialtyLabel} · ${m.loadPct}% loaded · ${m.open} open`} right={busy === m.id ? <Muted>…</Muted> : <Badge tone={m.loadPct > 100 ? 'bad' : 'neutral'}>{`${m.loadPct}%`}</Badge>} onPress={() => assign(m.id, m.name)} />
        ))}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </Card>
  );
}
