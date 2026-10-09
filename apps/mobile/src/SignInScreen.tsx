import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { needsSecondFactor, type Me } from '@bmu/shared';
import { api, API_URL, session } from './api';
import { colors, fonts } from './theme';

type Demo = { name: string; email: string; role: string };

export function SignInScreen({ onSignedIn, notice }: { onSignedIn: (me: Me) => void; notice?: string }) {
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'identify' | 'code' | 'second'>('identify');
  const [challenge, setChallenge] = useState<string>();
  const [second, setSecond] = useState('');
  const [devCode, setDevCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<Demo[]>([]);

  useEffect(() => {
    api.auth
      .demoAccounts()
      .then(setDemo)
      .catch(() => setError(`Can't reach the API at ${API_URL}. Run \`pnpm dev\` on your computer and keep the phone on the same Wi-Fi.`));
  }, []);

  async function requestCode(id = identifier) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.auth.requestOtp(id);
      setIdentifier(id);
      setDevCode(res.devCode);
      setCode(res.devCode ?? '');
      setStep('code');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.auth.verifyOtp(identifier, code);
      // v20: accounts with two-factor on need the code from their authenticator app (or a recovery code).
      if (needsSecondFactor(r)) {
        setChallenge(r.challenge);
        setStep('second');
        setBusy(false);
        return;
      }
      await session.save(r.token);
      onSignedIn(r.me);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function verifySecond() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.signIn.secondFactor(challenge!, second);
      await session.save(r.token);
      onSignedIn(r.me);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1}>Sign in</Text>
      <Text style={styles.muted}>Use the email or mobile number BMU has on file.</Text>
      {notice && step === 'identify' && <Text style={styles.notice}>{notice}</Text>}

      {step === 'second' ? (
        <>
          <Text style={[styles.muted, { marginTop: 16 }]}>Two-factor is on for this account. Enter the 6-digit code from your authenticator app, or one of your recovery codes.</Text>
          <TextInput style={styles.input} value={second} onChangeText={setSecond} placeholder="Code" autoCapitalize="characters" placeholderTextColor={colors.muted} />
          <Pressable style={styles.primary} onPress={verifySecond} disabled={busy}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>Continue</Text>}
          </Pressable>
          <Pressable onPress={() => setStep('identify')}>
            <Text style={[styles.muted, { marginTop: 12, textDecorationLine: 'underline' }]}>Start again</Text>
          </Pressable>
        </>
      ) : step === 'identify' ? (
        <>
          <TextInput
            style={styles.input}
            value={identifier}
            onChangeText={setIdentifier}
            placeholder="Email or mobile number"
            autoCapitalize="none"
            keyboardType="email-address"
            placeholderTextColor={colors.muted}
          />
          <Pressable style={styles.primary} onPress={() => requestCode()} disabled={busy}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>Send code</Text>}
          </Pressable>
        </>
      ) : (
        <>
          <Text style={[styles.muted, { marginTop: 16 }]}>Code sent to {identifier}</Text>
          {devCode && <Text style={styles.dev}>Development mode: your code is {devCode} (filled in).</Text>}
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="6-digit code"
            keyboardType="number-pad"
            maxLength={6}
            placeholderTextColor={colors.muted}
          />
          <Pressable style={styles.primary} onPress={verify} disabled={busy}>
            {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>Sign in</Text>}
          </Pressable>
          <Pressable onPress={() => setStep('identify')}>
            <Text style={[styles.muted, { marginTop: 12, textDecorationLine: 'underline' }]}>Use a different email or number</Text>
          </Pressable>
        </>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {step === 'identify' && demo.length > 0 && (
        <View style={{ marginTop: 32 }}>
          <Text style={styles.h2}>Demo accounts</Text>
          {demo.map((d) => (
            <Pressable key={d.email} style={styles.row} onPress={() => requestCode(d.email)}>
              <Text style={styles.rowTitle}>{d.name}</Text>
              <Text style={styles.muted}>{d.role}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { backgroundColor: '#FFFFFF', padding: 20, paddingBottom: 48, flexGrow: 1 },
  h1: { fontFamily: fonts.bodyBold, fontSize: 28, color: colors.charcoal, marginBottom: 6, letterSpacing: -0.5 },
  h2: { fontFamily: fonts.bodyBold, fontSize: 16, color: colors.charcoal, marginBottom: 8 },
  muted: { fontFamily: fonts.body, color: colors.muted },
  notice: { fontFamily: fonts.body, color: colors.charcoal, borderWidth: 1, borderColor: colors.line, padding: 10, marginTop: 12 },
  input: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: '#EBEAE6',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginTop: 16,
    fontFamily: fonts.body,
    color: colors.charcoal,
  },
  primary: { backgroundColor: colors.charcoal, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  primaryText: { fontFamily: fonts.bodyBold, color: '#FFFFFF' },
  dev: { fontFamily: fonts.body, backgroundColor: '#F2D27A55', padding: 10, marginTop: 12, color: colors.charcoal },
  error: { fontFamily: fonts.body, color: colors.statusRed, marginTop: 16 },
  row: {
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderColor: colors.line,
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rowTitle: { fontFamily: fonts.body, color: colors.charcoal },
});
