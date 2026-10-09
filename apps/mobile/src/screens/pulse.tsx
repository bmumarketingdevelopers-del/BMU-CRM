import { View, Text, StyleSheet } from 'react-native';
import { formatINR, type FlowPulse, type Me } from '@bmu/shared';
import { api } from '../api';
import { fonts, ui } from '../theme';
import { Body, Card, Empty, ErrorText, Loading, Muted, Screen, Section, Stats, Title, useData, when } from '../ui';

export const isFounderView = (me: Me) => me.type === 'staff' && me.roles.some((r) => r === 'founder' || r === 'admin');

/** Compact ₹ for tiles: ₹1.8L, ₹45k. */
const shortINR = (paise: number) => {
  const r = paise / 100;
  if (r >= 1_00_00_000) return `₹${(r / 1_00_00_000).toFixed(1)}Cr`;
  if (r >= 1_00_000) return `₹${(r / 1_00_000).toFixed(1)}L`;
  if (r >= 1000) return `₹${Math.round(r / 1000)}k`;
  return `₹${Math.round(r)}`;
};

function TargetBar({ p }: { p: FlowPulse }) {
  if (!p.targetPaise) return null;
  const pct = Math.min(100, Math.round((p.revenueMonthPaise / p.targetPaise) * 100));
  return (
    <View style={{ marginTop: 12 }}>
      <View style={st.track}>
        <View style={[st.fill, { width: `${pct}%`, backgroundColor: pct >= 100 ? ui.accent : ui.ink }]} />
      </View>
      <Muted style={{ marginTop: 6 }}>
        {pct}% of the {formatINR(p.targetPaise)} monthly target
      </Muted>
    </View>
  );
}

function Flow({ p }: { p: FlowPulse }) {
  const max = Math.max(1, ...p.stages.map((s) => s.count));
  return (
    <View style={st.flow}>
      {p.stages.map((s, i) => (
        <View key={s.key}>
          <View style={st.stage}>
            <Text style={st.tag}>{s.tag}</Text>
            <View style={{ flex: 1 }}>
              <Text style={st.stageLabel}>{s.label}</Text>
              <View style={[st.bar, { width: `${Math.max(4, (s.count / max) * 100)}%`, backgroundColor: s.stuck ? ui.warn : ui.ink }]} />
            </View>
            <Text style={st.count}>{s.count}</Text>
            <Text style={[st.stuck, { color: s.stuck ? '#b4432c' : ui.muted }]}>{s.stuck ? `${s.stuck} stuck` : '—'}</Text>
          </View>
          {i < p.stages.length - 1 && i !== 8 ? <View style={st.link} /> : null}
        </View>
      ))}
    </View>
  );
}

/** Founder Pulse: today's key numbers, the business flow as stage counts, and what needs the founder. */
export function Pulse({ me }: { me: Me }) {
  const d = useData(() => api.flows.pulse(), [], { cacheKey: 'pulse' });
  const p = d.data;
  if (!p)
    return (
      <Screen onRefresh={d.refresh} refreshing={d.refreshing}>
        {d.error ? <ErrorText>{d.error}</ErrorText> : <Loading />}
      </Screen>
    );
  const month = new Date(`${p.month}-01T00:00:00+05:30`).toLocaleDateString('en-IN', { month: 'long' });
  return (
    <Screen refreshing={d.refreshing} onRefresh={d.refresh}>
      <Title sub={`Pulse at ${when(p.asOf)}`}>Hello, {me.name.split(' ')[0]}</Title>
      <Card>
        <Muted>Revenue in {month} (ex GST)</Muted>
        <Text style={st.big}>{formatINR(p.revenueMonthPaise)}</Text>
        <TargetBar p={p} />
      </Card>
      <Stats
        items={[
          { label: 'Collected this month', value: shortINR(p.collectedMonthPaise) },
          { label: 'Outstanding', value: shortINR(p.outstandingPaise), tone: p.outstandingPaise ? 'warn' : undefined },
          { label: 'Overdue invoices', value: p.overdueInvoices, tone: p.overdueInvoices ? 'bad' : undefined },
          { label: 'Open leads', value: p.openLeads },
          { label: 'Stuck in flow', value: p.stuckItems, tone: p.stuckItems ? 'warn' : undefined },
          { label: 'Requests past SLA', value: p.requestsPastSla, tone: p.requestsPastSla ? 'bad' : undefined },
          { label: 'Tasks overdue', value: p.tasksOverdue, tone: p.tasksOverdue ? 'warn' : undefined },
          { label: 'Live in flow', value: p.stages.filter((s) => s.key !== 'retainer').reduce((n, s) => n + s.count, 0) },
        ]}
      />

      <Section>Needs you</Section>
      {p.needsYou.length ? (
        p.needsYou.map((n) => (
          <Card key={n.id} tone={n.tone === 'bad' ? 'bad' : n.tone === 'warn' ? 'warn' : undefined}>
            <Body bold>{n.title}</Body>
            <Muted style={{ marginTop: 4 }}>{n.detail}</Muted>
          </Card>
        ))
      ) : (
        <Empty>Nothing needs you right now.</Empty>
      )}

      <Section>Business flow</Section>
      <Flow p={p} />
      <Muted style={{ marginTop: 10 }}>The full flow map with drill-down is on the website under Command Centre → Business Flow Map.</Muted>
    </Screen>
  );
}

const st = StyleSheet.create({
  big: { fontFamily: fonts.bodyBold, fontSize: 32, color: ui.ink, marginTop: 4, letterSpacing: -0.5 },
  track: { height: 6, backgroundColor: ui.soft },
  fill: { height: 6 },
  flow: { borderWidth: 1, borderColor: ui.line, paddingHorizontal: 14, paddingVertical: 6 },
  stage: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  tag: { width: 44, fontFamily: fonts.body, fontSize: 11, color: ui.muted, textTransform: 'uppercase' },
  stageLabel: { fontFamily: fonts.body, fontSize: 14, color: ui.ink },
  bar: { height: 3, marginTop: 4 },
  count: { width: 32, textAlign: 'right', fontFamily: fonts.bodyBold, fontSize: 16, color: ui.ink },
  stuck: { width: 58, textAlign: 'right', fontFamily: fonts.body, fontSize: 12 },
  link: { width: 1, height: 8, backgroundColor: ui.line, marginLeft: 20 },
});
