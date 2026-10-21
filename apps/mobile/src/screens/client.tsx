import { useState } from 'react';
import { Image, Linking, View } from 'react-native';
import { formatINR, REQUEST_TYPES, requestStatusLabels, requestTypeLabels, type RequestType, type RequestView } from '@bmu/shared';
import { api, API_URL, authHeaders, fileUrl } from '../api';
import { GateTrack } from '../GateTrack';
import { ui } from '../theme';
import { Back, Badge, Body, Button, Card, Empty, ErrorText, Input, Loading, Muted, Pills, Row, Screen, Section, Stats, Title, useData, when } from '../ui';
import { ChatView } from './shared';

export type ClientNav = (tab: 'home' | 'reviews' | 'requests' | 'messages' | 'more', id?: string) => void;

// ---------------------------------------------------------------------------

export function ClientHome({ name, go }: { name: string; go: ClientNav }) {
  const d = useData(() => Promise.all([api.client.overview(), api.client.reviews(), api.client.requests().catch(() => []), api.client.delivery().catch(() => [])]), [], { cacheKey: 'client:home' });
  if (!d.data) return <Screen><Loading /><ErrorText>{d.error}</ErrorText></Screen>;
  const [o, reviews, requests, delivery] = d.data;
  const waiting = reviews.filter((r) => r.waitingOnYou);
  const quotes = requests.filter((r) => r.status === 'quoted');
  const finals = delivery.filter((x) => x.allApproved && !x.filesReleased);
  const due = o.invoicesDue.reduce((s, i) => s + i.totalPaise - i.paidPaise, 0);
  const nothing = !waiting.length && !quotes.length && !finals.length && !o.invoicesDue.length;
  return (
    <Screen refreshing={d.refreshing} onRefresh={d.refresh}>
      <Title sub={o.clientOrg.name}>Hello, {name.split(' ')[0]}</Title>
      <Stats
        items={[
          { label: 'Drafts to review', value: waiting.length, tone: waiting.length ? 'warn' : undefined },
          { label: 'Amount due', value: formatINR(due), tone: due ? 'warn' : undefined },
          { label: 'Active services', value: o.engagements.length },
          { label: 'Open requests', value: requests.filter((r) => !['done', 'declined'].includes(r.status)).length },
        ]}
      />
      <Section>What needs you</Section>
      {waiting.map((r) => (
        <Card key={r.id} tone="warn" onPress={() => go('reviews', r.id)}>
          <Body bold>{r.title}</Body>
          <Muted>Version {r.latestVersion} is ready for your review</Muted>
        </Card>
      ))}
      {quotes.map((r) => (
        <Card key={r.id} tone="warn" onPress={() => go('requests', r.id)}>
          <Body bold>A quote is ready</Body>
          <Muted>{r.description}</Muted>
        </Card>
      ))}
      {finals.map((x) => (
        <Card key={x.engagementId} tone="warn" onPress={() => go('more', 'files')}>
          <Body bold>{x.serviceName} is finished</Body>
          <Muted>Sign off and pay the final invoice to unlock your files.</Muted>
        </Card>
      ))}
      {o.invoicesDue.map((i) => (
        <Card key={i.id} tone="warn" onPress={() => go('more', 'billing')}>
          <Body bold>Invoice {i.number}</Body>
          <Muted>{formatINR(i.totalPaise - i.paidPaise)} due</Muted>
        </Card>
      ))}
      {nothing && (
        <Card>
          <Muted>Nothing is waiting on you right now.</Muted>
        </Card>
      )}
      <Section>Your services</Section>
      {o.engagements.map((e) => (
        <Card key={e.id}>
          <Body bold>{e.serviceName}</Body>
          <View style={{ marginTop: 10 }}>
            <GateTrack track={e.track} />
          </View>
        </Card>
      ))}
      {o.accountManager && (
        <>
          <Section>Your Client Manager</Section>
          <Card onPress={() => go('messages')}>
            <Body bold>{o.accountManager.name}</Body>
            <Muted>{o.accountManager.email ?? o.accountManager.phone}</Muted>
            <Muted style={{ marginTop: 6, textDecorationLine: 'underline' }}>Send a message</Muted>
          </Card>
        </>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------

export function ClientReviews({ id, go }: { id?: string; go: ClientNav }) {
  if (id) return <ReviewDetail id={id} onBack={() => go('reviews')} />;
  return <ReviewList go={go} />;
}

function ReviewList({ go }: { go: ClientNav }) {
  const list = useData(() => api.client.reviews(), [], { cacheKey: 'client:reviews' });
  return (
    <Screen refreshing={list.refreshing} onRefresh={list.refresh}>
      <Title sub="Look at drafts and approve when you're happy.">Review Studio</Title>
      {!list.data && <Loading />}
      {list.data?.map((r) => (
        <Row
          key={r.id}
          title={r.title}
          sub={`${r.serviceName} · ${r.statusLabel}`}
          right={r.waitingOnYou ? <Badge tone="warn">Review</Badge> : undefined}
          onPress={r.latestVersion ? () => go('reviews', r.id) : undefined}
        />
      ))}
      {list.data?.length === 0 && <Empty>No work yet.</Empty>}
      <ErrorText>{list.error}</ErrorText>
    </Screen>
  );
}

function ReviewDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const d = useData(() => api.client.review(id), [id], { cacheKey: `client:review:${id}` });
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const r = d.data;
  async function run(fn: () => Promise<typeof r>) {
    setBusy(true);
    setError(undefined);
    try {
      d.setData(await fn());
      setComment('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!r) return <Screen><Back onPress={onBack} /><Loading /><ErrorText>{d.error}</ErrorText></Screen>;
  const v = r.versions.at(-1);
  const thread = r.comments.filter((c) => c.versionId === v?.id);
  return (
    <Screen refreshing={d.refreshing} onRefresh={d.refresh}>
      <Back onPress={onBack} label="Review Studio" />
      <Title sub={`${r.serviceName}${v ? ` · version ${v.number}` : ''}`}>{r.title}</Title>
      {v && v.kind === 'image' && (
        <Image source={{ uri: fileUrl(v.url), headers: authHeaders() }} style={{ width: '100%', aspectRatio: 1, backgroundColor: ui.soft }} resizeMode="contain" />
      )}
      {v && v.kind !== 'image' && (
        <Card onPress={() => Linking.openURL(fileUrl(v.url))}>
          <Body bold>{v.name ?? 'Open file'}</Body>
          <Muted>{v.kind === 'link' ? 'Opens the live link' : 'Opens in your browser'}</Muted>
        </Card>
      )}
      {v?.approved && <Badge tone="good">{`Approved by ${v.approved.by}`}</Badge>}
      {r.approvalStatus && r.approvalStatus.mode !== 'any' && !v?.approved ? <Muted>{`${r.approvalStatus.modeLabel}: ${r.approvalStatus.summary}`}</Muted> : null}
      <Section>Comments</Section>
      {thread.map((c) => (
        <Card key={c.id}>
          <Muted>
            {c.author.name} · {when(c.at)}
          </Muted>
          <Body style={{ marginTop: 4 }}>{c.body}</Body>
        </Card>
      ))}
      {thread.length === 0 && <Muted>No comments yet. For pinned comments on the image, use the website.</Muted>}
      {r.can.comment && v && (
        <>
          <Input value={comment} onChangeText={setComment} placeholder="What should change?" multiline />
          <Button variant="secondary" title="Add comment" busy={busy} disabled={!comment.trim()} onPress={() => run(() => api.client.reviewComment(id, { body: comment.trim(), versionId: v.id }))} />
        </>
      )}
      {r.can.approve && v && <Button variant="accent" title={`Approve version ${v.number}`} busy={busy} onPress={() => run(() => api.client.approveVersion(id, v.id))} />}
      {r.can.requestChanges && <Button variant="secondary" title="Request changes" busy={busy} onPress={() => run(() => api.client.requestVersionChanges(id, comment.trim() || undefined))} />}
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}

// ---------------------------------------------------------------------------

export function ClientRequests({ id, go }: { id?: string; go: ClientNav }) {
  const [creating, setCreating] = useState(false);
  if (id) return <RequestDetail id={id} onBack={() => go('requests')} />;
  if (creating) return <NewRequest onDone={(r) => (setCreating(false), r && go('requests', r.id))} />;
  return <RequestList go={go} onNew={() => setCreating(true)} />;
}

const statusTone = (s: RequestView['status']) => (s === 'done' ? 'good' : s === 'declined' ? 'bad' : s === 'quoted' || s === 'approved' ? 'warn' : 'neutral');

function RequestList({ go, onNew }: { go: ClientNav; onNew: () => void }) {
  const list = useData(() => api.client.requests(), [], { cacheKey: 'client:requests' });
  return (
    <Screen refreshing={list.refreshing} onRefresh={list.refresh}>
      <Title sub="Changes, extra work, questions. Every request gets a reply within working hours.">Requests</Title>
      <Button title="New request" onPress={onNew} />
      <View style={{ marginTop: 12 }}>
        {!list.data && <Loading />}
        {list.data?.map((r) => (
          <Row key={r.id} title={r.description} sub={`${requestTypeLabels[r.type].client} · ${when(r.createdAt)}`} right={<Badge tone={statusTone(r.status)}>{requestStatusLabels[r.status].client}</Badge>} onPress={() => go('requests', r.id)} />
        ))}
        {list.data?.length === 0 && <Empty>No requests yet.</Empty>}
      </View>
      <ErrorText>{list.error}</ErrorText>
    </Screen>
  );
}

function NewRequest({ onDone }: { onDone: (r?: RequestView) => void }) {
  const o = useData(() => api.client.overview());
  const [type, setType] = useState<RequestType>('change');
  const [engagementId, setEngagementId] = useState<string>();
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const services = o.data?.engagements ?? [];
  const chosen = engagementId ?? services[0]?.id;
  async function submit() {
    if (!chosen) return;
    setBusy(true);
    setError(undefined);
    try {
      onDone(await api.client.createRequest({ engagementId: chosen, type, description }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Screen>
      <Back onPress={() => onDone()} label="Requests" />
      <Title>New request</Title>
      <Section>What kind?</Section>
      <Pills value={type} onChange={setType} options={REQUEST_TYPES.map((t) => ({ value: t, label: requestTypeLabels[t].client }))} />
      <Muted>{requestTypeLabels[type].hint}</Muted>
      {services.length > 1 && (
        <>
          <Section>Service</Section>
          <Pills value={chosen ?? ''} onChange={setEngagementId} options={services.map((s) => ({ value: s.id, label: s.serviceName }))} />
        </>
      )}
      <Section>Details</Section>
      <Input value={description} onChangeText={setDescription} placeholder="What do you need?" multiline />
      <Button title="Send request" busy={busy} disabled={description.trim().length < 5 || !chosen} onPress={submit} />
      {services.length === 0 && o.data && <Muted style={{ marginTop: 8 }}>You can raise requests once a service is active.</Muted>}
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}

function RequestDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const d = useData(() => api.client.request(id), [id], { cacheKey: `client:request:${id}` });
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const r = d.data;
  async function run(fn: () => Promise<RequestView | unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      d.setData(await api.client.request(id));
      setReply('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!r) return <Screen><Back onPress={onBack} /><Loading /><ErrorText>{d.error}</ErrorText></Screen>;
  return (
    <Screen refreshing={d.refreshing} onRefresh={d.refresh}>
      <Back onPress={onBack} label="Requests" />
      <Badge tone={statusTone(r.status)}>{requestStatusLabels[r.status].client}</Badge>
      <View style={{ height: 10 }} />
      <Title sub={`${requestTypeLabels[r.type].client} · ${r.engagement.serviceName}`}>{r.description}</Title>
      {r.quote && (
        <Card tone={r.status === 'quoted' ? 'warn' : undefined}>
          <Body bold>Quote{r.quote.addOnName ? `: ${r.quote.addOnName}` : ''}</Body>
          <Muted style={{ marginTop: 6 }}>
            {formatINR(r.quote.amountPaise)} + GST {formatINR(r.quote.gstPaise)}
          </Muted>
          <Body bold style={{ marginTop: 2 }}>Total {formatINR(r.quote.totalPaise)}</Body>
          {r.quote.timeline ? <Muted>Timeline: {r.quote.timeline}</Muted> : null}
          {r.can.approveQuote && (
            <>
              <Button variant="accent" title="Approve quote" busy={busy} onPress={() => run(() => api.client.approveQuote(id))} />
              <Button variant="secondary" title="Decline" busy={busy} onPress={() => run(() => api.client.declineQuote(id))} />
            </>
          )}
          {r.status === 'quoted' && !r.can.approveQuote && <Muted style={{ marginTop: 8 }}>Only your account owner can approve extra costs.</Muted>}
          {r.approval && <Muted style={{ marginTop: 8 }}>Approved by {r.approval.by}</Muted>}
        </Card>
      )}
      {r.invoice && (
        <Card>
          <Body bold>Invoice {r.invoice.number}</Body>
          <Muted>{formatINR(r.invoice.totalPaise)} · {r.invoice.status === 'paid' ? 'Paid. Work is scheduled.' : 'Payment due'}</Muted>
          {r.invoice.status !== 'paid' && <PayButton invoiceId={r.invoice.id} amountPaise={r.invoice.totalPaise} onPaid={() => d.reload()} />}
        </Card>
      )}
      <Section>Conversation</Section>
      {r.comments.map((c) => (
        <Card key={c.id} tone={c.isClient ? undefined : 'good'}>
          <Muted>
            {c.author} · {when(c.at)}
          </Muted>
          <Body style={{ marginTop: 4 }}>{c.body}</Body>
        </Card>
      ))}
      {r.comments.length === 0 && <Muted>Your Client Manager will reply here.</Muted>}
      <Input value={reply} onChangeText={setReply} placeholder="Add a reply" multiline />
      <Button variant="secondary" title="Reply" busy={busy} disabled={!reply.trim()} onPress={() => run(() => api.client.commentRequest(id, reply.trim()))} />
      <ErrorText>{error}</ErrorText>
    </Screen>
  );
}

// ---------------------------------------------------------------------------

export function PayButton({ invoiceId, amountPaise, onPaid }: { invoiceId: string; amountPaise: number; onPaid: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  async function pay() {
    setBusy(true);
    setMsg(undefined);
    try {
      const c = await api.client.checkout(invoiceId);
      if (c.mode === 'test') {
        await api.client.payTest(invoiceId);
        setMsg('Test payment done: no real money moved.');
        onPaid();
      } else if (c.mode === 'razorpay') setMsg('Please pay this invoice on the website (Billing). Card and UPI payments open there.');
      else if (c.mode === 'paid') onPaid();
      else setMsg("Online payment isn't set up yet. Please contact your Client Manager.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="accent" title={`Pay ${formatINR(amountPaise)}`} busy={busy} onPress={pay} />
      {msg ? <Muted style={{ marginTop: 6 }}>{msg}</Muted> : null}
    </>
  );
}

export function ClientMessages() {
  const t = useData(() => api.client.thread(), [], { cacheKey: 'client:thread' });
  if (!t.data) return <Screen><Loading /><ErrorText>{t.error}</ErrorText></Screen>;
  return (
    <Screen refreshing={t.refreshing} onRefresh={t.refresh}>
      <ChatView thread={t.data} title="Messages" sub={t.data.am ? `With ${t.data.am}, your Client Manager` : undefined} onSend={async (body) => t.setData(await api.client.sendMessage(body))} />
    </Screen>
  );
}

export function ClientBilling({ onBack }: { onBack: () => void }) {
  const inv = useData(() => api.client.invoices(), [], { cacheKey: 'client:invoices' });
  return (
    <Screen refreshing={inv.refreshing} onRefresh={inv.refresh}>
      <Back onPress={onBack} label="More" />
      <Title sub="GST (18%) is shown separately on each invoice.">Billing</Title>
      {!inv.data && !inv.error && <Loading />}
      {inv.data?.map((i) => (
        <Card key={i.id} tone={i.status === 'paid' ? undefined : 'warn'}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Body bold>{i.number}</Body>
            <Badge tone={i.status === 'paid' ? 'good' : i.status === 'overdue' ? 'bad' : 'warn'}>{i.status.replace('_', ' ')}</Badge>
          </View>
          <Muted style={{ marginTop: 4 }}>
            {formatINR(i.subtotalPaise)} + GST {formatINR(i.gstPaise)} = {formatINR(i.totalPaise)}
          </Muted>
          {i.status !== 'paid' && i.status !== 'cancelled' && <PayButton invoiceId={i.id} amountPaise={i.totalPaise - i.paidPaise} onPaid={() => inv.reload()} />}
        </Card>
      ))}
      {inv.data?.length === 0 && <Empty>No invoices yet.</Empty>}
      <ErrorText>{inv.error ? "Billing isn't part of your access. Ask your account owner." : undefined}</ErrorText>
    </Screen>
  );
}

export function ClientFiles({ onBack }: { onBack: () => void }) {
  const d = useData(() => Promise.all([api.client.delivery(), api.client.files()]), [], { cacheKey: 'client:files' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!d.data) return <Screen><Back onPress={onBack} label="More" /><Loading /><ErrorText>{d.error}</ErrorText></Screen>;
  const [delivery, files] = d.data;
  return (
    <Screen refreshing={d.refreshing} onRefresh={d.refresh}>
      <Back onPress={onBack} label="More" />
      <Title sub="Final files unlock after sign-off and the final payment.">Files</Title>
      {delivery
        .filter((x) => x.allApproved)
        .map((x) => (
          <Card key={x.engagementId} tone={x.filesReleased ? 'good' : 'warn'}>
            <Body bold>Final delivery · {x.serviceName}</Body>
            <Muted style={{ marginTop: 4 }}>{x.signedOffAt ? '✓ Signed off' : '1. Sign off the finished work'}</Muted>
            <Muted>{!x.balanceInvoice || x.balanceInvoice.status === 'paid' ? '✓ Final invoice paid' : `2. Pay ${x.balanceInvoice.number}`}</Muted>
            {!x.signedOffAt && x.can.signOff && (
              <Button
                title="Sign off"
                busy={busy}
                onPress={async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    await api.client.signOff(x.engagementId);
                    await d.reload();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            )}
            {x.balanceInvoice && x.balanceInvoice.status !== 'paid' && <PayButton invoiceId={x.balanceInvoice.id} amountPaise={x.balanceInvoice.totalPaise - x.balanceInvoice.paidPaise} onPaid={() => d.reload()} />}
          </Card>
        ))}
      <ErrorText>{error}</ErrorText>
      <Section>Approved work</Section>
      {files.map((f) => (
        <Row
          key={f.id}
          title={f.deliverable}
          sub={`${f.serviceName} · v${f.version}${f.preview ? ' · view only in the web portal until the final payment' : ''}`}
          right={<Badge tone={f.downloadUrl ? 'good' : 'neutral'}>{f.downloadUrl ? 'Ready' : f.preview ? '🔒 View only' : '🔒 Locked'}</Badge>}
          // v37: before the final payment, videos play (watermarked) in the web portal; images and PDFs open watermarked.
          // v39: view only before the final payment: the web portal's viewer (no download), not the phone's browser.
          onPress={() => Linking.openURL(f.preview ? `${API_URL.replace(/\/api\/?$/, '')}/client/files` : fileUrl(f.url))}
        />
      ))}
      {files.length === 0 && <Empty>Approved work appears here.</Empty>}
    </Screen>
  );
}
