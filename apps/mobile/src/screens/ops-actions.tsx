// v11 ops: mobile uploads and the client's floating "+".
// Team: "+" → Photo or video uploads into a client's folder. Clients: a floating "+" on every tab with Request and
// Photo or video (lands in "From client" and tells the Client Manager). The server checks every action again.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { REQUEST_TYPES, requestTypeLabels, type RequestType } from '@bmu/shared';
import { api } from '../api';
import { fonts, ui } from '../theme';
import { Body, Button, ErrorText, Input, Muted, Pills, Row } from '../ui';
import { Sheet, useRun } from './core-actions';

type OpsThreadOptions = Awaited<ReturnType<typeof api.ops.threads.options>>;
type Picked = { uri: string; name: string; type: string };

/** Pick a photo or video from the library, or take one with the camera. Returns null when cancelled. */
async function pickMedia(source: 'library' | 'camera'): Promise<Picked | null> {
  const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error(source === 'camera' ? 'Allow camera access in your phone settings to take a photo' : 'Allow photo access in your phone settings to pick a file');
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images', 'videos'], quality: 0.85 };
  const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (r.canceled || !r.assets?.length) return null;
  const a = r.assets[0];
  const type = a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg');
  return { uri: a.uri, type, name: a.fileName ?? `upload-${Date.now()}.${type.split('/')[1] ?? 'jpg'}` };
}
/** React Native's FormData takes { uri, name, type } in place of a Blob. */
const asBlob = (p: Picked) => p as unknown as Blob;

function MediaPicker({ value, onChange, onError }: { value: Picked | null; onChange: (p: Picked | null) => void; onError: (m: string) => void }) {
  const pick = (src: 'library' | 'camera') => pickMedia(src).then((p) => p && onChange(p), (e: Error) => onError(e.message));
  return value ? (
    <View style={st.picked}>
      <Body style={{ flex: 1 }}>{value.name}</Body>
      <Pressable onPress={() => onChange(null)} hitSlop={10} accessibilityLabel="Remove file">
        <Muted>Change</Muted>
      </Pressable>
    </View>
  ) : (
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
      <View style={{ flex: 1 }}>
        <Button variant="secondary" title="Choose photo or video" onPress={() => pick('library')} />
      </View>
      <View style={{ flex: 1 }}>
        <Button variant="secondary" title="Use camera" onPress={() => pick('camera')} />
      </View>
    </View>
  );
}

/** Team: upload a photo or video to a client's folder (Working files unless chosen otherwise). */
export function OpsMediaUpload({ onClose }: { onClose: (message?: string) => void }) {
  const [opts, setOpts] = useState<OpsThreadOptions>();
  const [clientId, setClientId] = useState('');
  const [engagementId, setEngagementId] = useState('');
  const [folder, setFolder] = useState<'working' | 'final' | 'brand' | 'general'>('working');
  const [file, setFile] = useState<Picked | null>(null);
  const [tags, setTags] = useState('');
  const { busy, error, setError, run } = useRun();
  useEffect(() => {
    api.ops.threads.options().then(setOpts, (e: Error) => setError(e.message));
  }, [setError]);
  const client = opts?.clients.find((c) => c.id === clientId);
  return (
    <Sheet open title="Upload photo or video" onClose={() => onClose()}>
      <Muted>Client</Muted>
      {opts?.clients.length === 0 && <Muted>No clients you can upload for.</Muted>}
      {opts?.clients.slice(0, 30).map((c) => (
        <Pressable key={c.id} onPress={() => (setClientId(c.id), setEngagementId(''))} style={[st.choice, clientId === c.id && st.choiceOn]} accessibilityRole="radio" accessibilityState={{ selected: clientId === c.id }}>
          <Body>{c.name}</Body>
        </Pressable>
      ))}
      {client && client.engagements.length > 0 && (
        <View style={{ marginTop: 12 }}>
          <Muted>Project (optional)</Muted>
          <Pills value={engagementId} onChange={setEngagementId} options={[{ value: '', label: 'None' }, ...client.engagements.map((e) => ({ value: e.id, label: e.name }))]} />
        </View>
      )}
      <View style={{ marginTop: 12 }}>
        <Muted>Folder</Muted>
        <Pills value={folder} onChange={setFolder} options={[{ value: 'working', label: 'Working' }, { value: 'final', label: 'Final' }, { value: 'brand', label: 'Brand' }, { value: 'general', label: 'General' }]} />
      </View>
      <MediaPicker value={file} onChange={setFile} onError={setError} />
      <Input value={tags} onChangeText={setTags} placeholder="Tags, separated by commas (optional)" accessibilityLabel="Tags" />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Upload"
        busy={busy}
        onPress={() =>
          run(async () => {
            if (!clientId) throw new Error('Pick the client');
            if (!file) throw new Error('Choose a photo or video');
            const r = await api.ops.files.upload(asBlob(file), { clientOrgId: clientId, engagementId: engagementId || undefined, folder, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) });
            onClose(r.message);
          })
        }
      />
    </Sheet>
  );
}

/** Client: floating "+" on every tab: Request, or Photo or video for the team. */
export function ClientQuickAdd({ onDone }: { onDone: (message: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [form, setForm] = useState<'request' | 'media' | null>(null);
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
        <Row title="Request" sub="A change, extra work or a question" onPress={() => (setMenu(false), setForm('request'))} />
        <Row title="Photo or video" sub="Send files to your team" onPress={() => (setMenu(false), setForm('media'))} />
      </Sheet>
      {form === 'request' && <ClientRequestSheet onClose={close} />}
      {form === 'media' && <ClientMediaSheet onClose={close} />}
    </>
  );
}

function ClientRequestSheet({ onClose }: { onClose: (message?: string) => void }) {
  const [services, setServices] = useState<{ id: string; serviceName: string }[]>();
  const [engagementId, setEngagementId] = useState('');
  const [type, setType] = useState<RequestType>('change');
  const [description, setDescription] = useState('');
  const { busy, error, setError, run } = useRun();
  useEffect(() => {
    api.client.overview().then(
      (o) => {
        setServices(o.engagements);
        if (o.engagements.length) setEngagementId(o.engagements[0].id);
      },
      (e: Error) => setError(e.message),
    );
  }, [setError]);
  return (
    <Sheet open title="New request" onClose={() => onClose()}>
      <Pills value={type} onChange={setType} options={REQUEST_TYPES.map((t) => ({ value: t, label: requestTypeLabels[t].client }))} />
      <Muted>{requestTypeLabels[type].hint}</Muted>
      {services && services.length > 1 && <Pills value={engagementId} onChange={setEngagementId} options={services.map((s) => ({ value: s.id, label: s.serviceName }))} />}
      {services?.length === 0 && <Muted>You can raise requests once a service is active.</Muted>}
      <Input value={description} onChangeText={setDescription} placeholder="What do you need?" multiline maxLength={4000} accessibilityLabel="What do you need" />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Send request"
        busy={busy}
        onPress={() =>
          run(async () => {
            if (!engagementId) throw new Error('You can raise requests once a service is active');
            if (description.trim().length < 5) throw new Error('Tell us a little more (at least 5 characters)');
            await api.client.createRequest({ engagementId, type, description: description.trim() });
            onClose('Request sent. Your team will reply within working hours.');
          })
        }
      />
    </Sheet>
  );
}

function ClientMediaSheet({ onClose }: { onClose: (message?: string) => void }) {
  const [file, setFile] = useState<Picked | null>(null);
  const [note, setNote] = useState('');
  const { busy, error, setError, run } = useRun();
  return (
    <Sheet open title="Send a photo or video" onClose={() => onClose()}>
      <Muted>It goes to your team's "From client" folder and your Client Manager is told.</Muted>
      <MediaPicker value={file} onChange={setFile} onError={setError} />
      <Input value={note} onChangeText={setNote} placeholder="Note for the team (optional)" maxLength={500} accessibilityLabel="Note for the team" />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Send"
        busy={busy}
        onPress={() =>
          run(async () => {
            if (!file) throw new Error('Choose a photo or video');
            const r = await api.ops.files.clientUpload(asBlob(file), { note: note.trim() || undefined });
            onClose(r.message);
          })
        }
      />
    </Sheet>
  );
}

const st = StyleSheet.create({
  fab: { position: 'absolute', right: 20, bottom: 16, width: 56, height: 56, backgroundColor: ui.ink, alignItems: 'center', justifyContent: 'center', elevation: 4 },
  fabText: { color: '#fff', fontSize: 28, fontFamily: fonts.bodyBold, marginTop: -2 },
  choice: { borderWidth: 1, borderColor: ui.line, padding: 12, marginTop: 8 },
  choiceOn: { borderColor: ui.ink, backgroundColor: ui.soft },
  picked: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: ui.line, padding: 12, marginTop: 8 },
});
