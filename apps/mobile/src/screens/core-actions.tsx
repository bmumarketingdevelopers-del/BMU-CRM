// v11 core: mobile actions. A floating "+" on every team tab (Task / Note / Blocked report), and the reassign and
// deadline sheets used by task cards. Same API and rules as the website: the server checks every action again.
import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { canOpenCraftManager, coreReassignReasonLabels, type CoreCandidates, type CoreReassignReason, type CoreTaskFormOptions, type CoreTaskRow, type Me } from '@bmu/shared';
import { api } from '../api';
import { fonts, ui } from '../theme';
import { Body, Button, ErrorText, Input, Muted, Pills, Row, s } from '../ui';
import { OpsMediaUpload } from './ops-actions';

const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <View style={st.backdrop}>
        <View style={st.sheet}>
          <View style={st.sheetHead}>
            <Text style={s.bold}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close">
              <Text style={s.muted}>Close</Text>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 32 }}>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

// ---------------------------------------------------------------------------
// Floating "+"

export function QuickAdd({ me, onDone }: { me: Me; onDone: (message: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [form, setForm] = useState<'task' | 'note' | 'blocked' | 'media' | null>(null);
  const canNote = canOpenCraftManager(me);
  const close = (message?: string) => {
    setForm(null);
    if (message) onDone(message);
  };
  return (
    <>
      <Pressable onPress={() => setMenu(true)} style={({ pressed }) => [st.fab, { opacity: pressed ? 0.8 : 1 }]} accessibilityLabel="Add" accessibilityRole="button">
        <Text style={st.fabText}>+</Text>
      </Pressable>
      <Sheet open={menu} title="Add" onClose={() => setMenu(false)}>
        <Row title="Task" sub="For a client or internal" onPress={() => (setMenu(false), setForm('task'))} />
        {canNote && <Row title="Note" sub="On a client's record" onPress={() => (setMenu(false), setForm('note'))} />}
        <Row title="Blocked report" sub="Something is stopping one of your tasks" onPress={() => (setMenu(false), setForm('blocked'))} />
        <Row title="Photo or video" sub="Upload to a client's files" onPress={() => (setMenu(false), setForm('media'))} />
      </Sheet>
      {form === 'task' && <QuickTask onClose={close} />}
      {form === 'note' && <QuickNote onClose={close} />}
      {form === 'blocked' && <BlockedReport onClose={close} />}
      {form === 'media' && <OpsMediaUpload onClose={close} />}
    </>
  );
}

function QuickTask({ onClose }: { onClose: (message?: string) => void }) {
  const [opts, setOpts] = useState<CoreTaskFormOptions>();
  const [title, setTitle] = useState('');
  const [internal, setInternal] = useState<'client' | 'internal'>('client');
  const [engagementId, setEngagementId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [deadline, setDeadline] = useState(todayIst());
  const { busy, error, setError, run } = useRun();
  useEffect(() => {
    api.coreTasks.formOptions().then(
      (o) => {
        setOpts(o);
        setOwnerId(o.canAssignOthers ? '' : o.me.id);
        if (!o.engagements.length) setInternal('internal');
      },
      (e: Error) => setError(e.message),
    );
  }, [setError]);
  const save = () =>
    run(async () => {
      if (title.trim().length < 3) throw new Error('Give the task a title (at least 3 characters)');
      if (internal === 'client' && !engagementId) throw new Error('Pick the client, or choose Internal');
      if (!ownerId) throw new Error('Pick who does it');
      if (!isDay(deadline)) throw new Error('Write the deadline as YYYY-MM-DD');
      const eng = opts?.engagements.find((e) => e.id === engagementId);
      const m = await api.coreTasks.create({
        title: title.trim(),
        internal: internal === 'internal',
        engagementId: internal === 'client' ? engagementId : null,
        departmentId: eng?.departmentIds.find((d) => d === opts?.me.departmentId) ?? opts?.me.departmentId ?? eng?.departmentIds[0] ?? opts?.departments[0]?.id ?? '',
        ownerId,
        deadline,
        // Before Gate 3 only planning work can be added.
        preProduction: internal === 'client' && !!eng && !eng.productionOpen,
      });
      onClose(m.message ?? 'Task added');
    });
  return (
    <Sheet open title="New task" onClose={() => onClose()}>
      <Input value={title} onChangeText={setTitle} placeholder="Title" maxLength={200} accessibilityLabel="Title" />
      <View style={{ marginTop: 12 }}>
        <Pills value={internal} onChange={setInternal} options={[{ value: 'client', label: 'For a client' }, { value: 'internal', label: 'Internal' }]} />
      </View>
      {internal === 'client' &&
        (opts?.engagements ?? []).slice(0, 30).map((e) => (
          <Pressable key={e.id} onPress={() => setEngagementId(e.id)} style={[st.choice, engagementId === e.id && st.choiceOn]}>
            <Text style={s.text}>
              {e.client} · {e.service}
            </Text>
            {!e.productionOpen && <Text style={s.muted}>Before production: only planning work</Text>}
          </Pressable>
        ))}
      {opts?.canAssignOthers ? (
        <>
          <Muted style={{ marginTop: 12 }}>Who does it</Muted>
          {opts.people.slice(0, 40).map((p) => (
            <Pressable key={p.id} onPress={() => setOwnerId(p.id)} style={[st.choice, ownerId === p.id && st.choiceOn]}>
              <Text style={s.text}>{p.name}</Text>
            </Pressable>
          ))}
        </>
      ) : (
        <Muted style={{ marginTop: 12 }}>It is assigned to you.</Muted>
      )}
      <Muted style={{ marginTop: 12 }}>Deadline (YYYY-MM-DD)</Muted>
      <Input value={deadline} onChangeText={setDeadline} autoCapitalize="none" accessibilityLabel="Deadline" />
      <ErrorText>{error}</ErrorText>
      <Button title="Add task" busy={busy} onPress={save} />
    </Sheet>
  );
}

function QuickNote({ onClose }: { onClose: (message?: string) => void }) {
  const [opts, setOpts] = useState<CoreTaskFormOptions>();
  const [clientId, setClientId] = useState('');
  const [body, setBody] = useState('');
  const { busy, error, setError, run } = useRun();
  useEffect(() => {
    api.coreTasks.formOptions().then(setOpts, (e: Error) => setError(e.message));
  }, [setError]);
  const clients = [...new Map((opts?.engagements ?? []).map((e) => [e.clientId, e.client])).entries()];
  return (
    <Sheet open title="New note" onClose={() => onClose()}>
      {clients.map(([id, name]) => (
        <Pressable key={id} onPress={() => setClientId(id)} style={[st.choice, clientId === id && st.choiceOn]}>
          <Text style={s.text}>{name}</Text>
        </Pressable>
      ))}
      <Input value={body} onChangeText={setBody} placeholder="Note" multiline maxLength={2000} accessibilityLabel="Note" />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Save note"
        busy={busy}
        onPress={() =>
          run(async () => {
            if (!clientId) throw new Error('Pick the client');
            if (body.trim().length < 2) throw new Error('Write a short note');
            await api.craftManager.addClientNote(clientId, { kind: 'note', body: body.trim(), remindAt: null });
            onClose('Note added');
          })
        }
      />
    </Sheet>
  );
}

function BlockedReport({ onClose }: { onClose: (message?: string) => void }) {
  const [tasks, setTasks] = useState<CoreTaskRow[]>();
  const [taskId, setTaskId] = useState('');
  const [reason, setReason] = useState('');
  const [waitingFor, setWaitingFor] = useState('');
  const [who, setWho] = useState('');
  const [expectedAt, setExpectedAt] = useState(todayIst());
  const { busy, error, setError, run } = useRun();
  useEffect(() => {
    api.coreTasks.query({ scope: 'mine' }).then((r) => setTasks(r.filter((t) => t.can.status && t.status !== 'blocked' && ['todo', 'in_progress', 'waiting'].includes(t.status))), (e: Error) => setError(e.message));
  }, [setError]);
  return (
    <Sheet open title="Blocked report" onClose={() => onClose()}>
      {tasks && !tasks.length && <Muted>You have no open tasks to report.</Muted>}
      {(tasks ?? []).slice(0, 30).map((t) => (
        <Pressable key={t.id} onPress={() => setTaskId(t.id)} style={[st.choice, taskId === t.id && st.choiceOn]}>
          <Text style={s.text}>{t.title}</Text>
          {t.client && <Text style={s.muted}>{t.client.name}</Text>}
        </Pressable>
      ))}
      <Input value={reason} onChangeText={setReason} placeholder="Why is it blocked?" multiline maxLength={500} accessibilityLabel="Why is it blocked" />
      <Input value={waitingFor} onChangeText={setWaitingFor} placeholder="Waiting for (e.g. logo files)" maxLength={200} accessibilityLabel="Waiting for" />
      <Input value={who} onChangeText={setWho} placeholder="Who can unblock it (name or 'client')" maxLength={120} accessibilityLabel="Who can unblock it" />
      <Muted style={{ marginTop: 12 }}>Expected by (YYYY-MM-DD)</Muted>
      <Input value={expectedAt} onChangeText={setExpectedAt} autoCapitalize="none" accessibilityLabel="Expected by" />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Report blocked"
        busy={busy}
        onPress={() =>
          run(async () => {
            if (!taskId) throw new Error('Pick the task');
            if (!isDay(expectedAt)) throw new Error('Write the date as YYYY-MM-DD');
            const m = await api.coreTasks.status(taskId, 'blocked', { reason: reason.trim(), waitingFor: waitingFor.trim(), responsibleName: who.trim() || 'Not sure', expectedAt });
            onClose(m.message ?? 'Marked blocked');
          })
        }
      />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Task card actions

export function TaskActionButtons({ t, onDone }: { t: CoreTaskRow; onDone: (message: string) => void }) {
  const [sheet, setSheet] = useState<'reassign' | 'deadline' | null>(null);
  if (!t.can.reassign && !t.can.deadline) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {t.can.reassign && !t.can.blocked.reassign && (
        <View style={{ flex: 1 }}>
          <Button variant="secondary" title={t.owner ? 'Reassign' : 'Assign'} onPress={() => setSheet('reassign')} />
        </View>
      )}
      {t.can.deadline && (
        <View style={{ flex: 1 }}>
          <Button variant="secondary" title={t.can.deadline === 'request' ? 'Ask new date' : 'Deadline'} onPress={() => setSheet('deadline')} />
        </View>
      )}
      {sheet === 'reassign' && <ReassignSheet t={t} onClose={(m) => (setSheet(null), m && onDone(m))} />}
      {sheet === 'deadline' && <DeadlineSheet t={t} onClose={(m) => (setSheet(null), m && onDone(m))} />}
    </View>
  );
}

function ReassignSheet({ t, onClose }: { t: CoreTaskRow; onClose: (message?: string) => void }) {
  const [c, setC] = useState<CoreCandidates>();
  const [to, setTo] = useState('');
  const [reason, setReason] = useState<CoreReassignReason>('overload');
  const [note, setNote] = useState('');
  const [handover, setHandover] = useState('');
  const { busy, error, setError, run } = useRun();
  useEffect(() => {
    api.actions.reassign.candidates('task', [t.id]).then(setC, (e: Error) => setError(e.message));
  }, [t.id, setError]);
  const inProgress = t.status === 'in_progress';
  return (
    <Sheet open title={`Reassign: ${t.title}`} onClose={() => onClose()}>
      {!c && !error && <Muted>Loading people…</Muted>}
      {(c?.candidates ?? []).slice(0, 40).map((p) => {
        const disabled = !!p.blockedReason || p.current;
        return (
          <Pressable key={p.id} disabled={disabled} onPress={() => setTo(p.id)} style={[st.choice, to === p.id && st.choiceOn, disabled && { opacity: 0.4 }]}>
            <Text style={s.text}>
              {p.name}
              {p.suggested ? '  · best fit' : ''}
              {p.current ? '  (current)' : ''}
            </Text>
            <Text style={[s.muted, p.loadAfterPct > 100 ? { color: '#b4432c' } : null]}>
              {p.loadAfterPct >= 999 ? 'On leave all week' : `${p.loadAfterPct}% after`} · {p.openTasks} open{p.onLeave ? ' · on leave on the deadline' : ''}
            </Text>
          </Pressable>
        );
      })}
      <Muted style={{ marginTop: 12 }}>Reason</Muted>
      <Pills value={reason} onChange={setReason} options={(Object.keys(coreReassignReasonLabels) as CoreReassignReason[]).map((k) => ({ value: k, label: coreReassignReasonLabels[k] }))} />
      <Input value={note} onChangeText={setNote} placeholder="Note (optional)" maxLength={2000} accessibilityLabel="Note" />
      {inProgress && <Input value={handover} onChangeText={setHandover} placeholder="Handover note: where it is up to" multiline maxLength={4000} accessibilityLabel="Handover note" />}
      <ErrorText>{error}</ErrorText>
      <Button
        title="Reassign"
        busy={busy}
        onPress={() =>
          run(async () => {
            if (!to) throw new Error('Pick the new owner');
            if (inProgress && handover.trim().length < 3) throw new Error('Add a short handover note: the work has started');
            const r = await api.actions.reassign.apply('task', { ids: [t.id], toUserId: to, reason, note: note.trim() || undefined, handoverNote: handover.trim() || undefined, deadline: { mode: 'keep' } });
            onClose(r.message);
          })
        }
      />
    </Sheet>
  );
}

function DeadlineSheet({ t, onClose }: { t: CoreTaskRow; onClose: (message?: string) => void }) {
  const [date, setDate] = useState(t.deadline ? new Date(new Date(t.deadline).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : todayIst());
  const [reason, setReason] = useState('');
  const { busy, error, run } = useRun();
  const request = t.can.deadline === 'request';
  return (
    <Sheet open title={request ? 'Ask for a new deadline' : 'Change deadline'} onClose={() => onClose()}>
      <Body>{t.title}</Body>
      {request && <Muted style={{ marginTop: 4 }}>Your Department Head decides. The current deadline stays until they approve.</Muted>}
      <Muted style={{ marginTop: 12 }}>New deadline (YYYY-MM-DD)</Muted>
      <Input value={date} onChangeText={setDate} autoCapitalize="none" accessibilityLabel="New deadline" />
      <Input value={reason} onChangeText={setReason} placeholder="Reason" multiline maxLength={500} accessibilityLabel="Reason" />
      <ErrorText>{error}</ErrorText>
      <Button
        title={request ? 'Send request' : 'Change deadline'}
        busy={busy}
        onPress={() =>
          run(async () => {
            if (!isDay(date)) throw new Error('Write the date as YYYY-MM-DD');
            if (reason.trim().length < 3) throw new Error('Give a short reason (at least 3 characters)');
            const m = await api.coreTasks.deadline(t.id, date, reason.trim());
            onClose(m.message ?? 'Saved');
          })
        }
      />
    </Sheet>
  );
}

const st = StyleSheet.create({
  fab: { position: 'absolute', right: 20, bottom: 16, width: 56, height: 56, backgroundColor: ui.ink, alignItems: 'center', justifyContent: 'center', elevation: 4 },
  fabText: { color: '#fff', fontSize: 28, fontFamily: fonts.bodyBold, marginTop: -2 },
  backdrop: { flex: 1, backgroundColor: 'rgba(18,31,47,0.35)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: ui.bg, maxHeight: '88%', paddingHorizontal: 20, paddingTop: 16 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  choice: { borderWidth: 1, borderColor: ui.line, padding: 12, marginTop: 8 },
  choiceOn: { borderColor: ui.ink, backgroundColor: ui.soft },
});
