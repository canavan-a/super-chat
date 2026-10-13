import React, {useMemo, useState} from 'react';
import {ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {
  entropyFromPhrase,
  exportKeyFile,
  Identity,
  identityFromEntropy,
  importKeyFile,
  newIdentity,
  phraseFromEntropy,
  randomBytes,
} from '../crypto';
import {pickTextFile, saveTextFile} from '../files';
import {NEEDS_PASSPHRASE, storeIdentity} from '../keystore';
import {LogoArt} from '../logo/LogoArt';
import {Theme, useTheme} from '../theme';

type Step =
  | {name: 'welcome'}
  | {name: 'show'; me: Identity}
  | {name: 'confirm'; me: Identity; ask: number[]}
  | {name: 'importPhrase'}
  | {name: 'importFile'; json: string}
  | {name: 'protect'; me: Identity};

/**
 * First run. There's no sign-up and no login: "Create" makes a fresh key
 * locally and shows its 24-word recovery phrase; "Import" brings an existing
 * one back from the phrase or a key file.
 */
export function OnboardingScreen({onDone}: {onDone: (entropy: Uint8Array) => void}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [step, setStep] = useState<Step>({name: 'welcome'});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = async (me: Identity, passphrase?: string) => {
    setBusy(true);
    setError(null);
    try {
      await storeIdentity(me.entropy, passphrase);
      onDone(me.entropy);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const store = (me: Identity) => (NEEDS_PASSPHRASE ? setStep({name: 'protect', me}) : finish(me));

  const go = (s: Step) => {
    setError(null);
    setStep(s);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {step.name === 'welcome' && (
        <View style={styles.center}>
          <LogoArt width={300} />
          <Text style={styles.lead}>End-to-end encrypted rooms. No sign-up, no phone number, no email.</Text>
          <Text style={styles.body}>
            Your account is a key that lives on this device. The server stores only ciphertext and can't read your
            rooms.
          </Text>
          <Pressable style={styles.primary} onPress={() => go({name: 'show', me: newIdentity()})}>
            <Text style={styles.primaryText}>Create a new account</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => go({name: 'importPhrase'})}>
            <Text style={styles.secondaryText}>I have a recovery phrase</Text>
          </Pressable>
          <Pressable
            style={styles.secondary}
            onPress={async () => {
              try {
                const json = await pickTextFile();
                if (json) go({name: 'importFile', json});
              } catch (e) {
                setError((e as Error).message);
              }
            }}>
            <Text style={styles.secondaryText}>Import a key file</Text>
          </Pressable>
        </View>
      )}

      {step.name === 'show' && <ShowPhrase me={step.me} styles={styles} onNext={ask => go({name: 'confirm', me: step.me, ask})} />}

      {step.name === 'confirm' && (
        <ConfirmPhrase
          me={step.me}
          ask={step.ask}
          styles={styles}
          theme={theme}
          busy={busy}
          onBack={() => go({name: 'show', me: step.me})}
          onOk={() => store(step.me)}
        />
      )}

      {step.name === 'importPhrase' && (
        <ImportPhrase
          styles={styles}
          theme={theme}
          busy={busy}
          onBack={() => go({name: 'welcome'})}
          onOk={phrase => {
            try {
              const entropy = entropyFromPhrase(phrase);
              store(identityFromEntropy(entropy));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      )}

      {step.name === 'importFile' && (
        <PassphraseForm
          title="Unlock key file"
          hint="Enter the passphrase you chose when you saved this key file."
          confirm={false}
          styles={styles}
          theme={theme}
          busy={busy}
          onBack={() => go({name: 'welcome'})}
          onOk={async pass => {
            setBusy(true);
            setError(null);
            try {
              const me = await importKeyFile(step.json, pass);
              setBusy(false);
              store(me);
            } catch (e) {
              setBusy(false);
              setError((e as Error).message);
            }
          }}
        />
      )}

      {step.name === 'protect' && (
        <PassphraseForm
          title="Protect this browser"
          hint="Your key is kept in this browser encrypted with a passphrase. You'll enter it each time you open Super Chat here."
          confirm
          styles={styles}
          theme={theme}
          busy={busy}
          onBack={() => go({name: 'welcome'})}
          onOk={pass => finish(step.me, pass)}
        />
      )}

      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

function ShowPhrase({me, styles, onNext}: {me: Identity; styles: Styles; onNext: (ask: number[]) => void}) {
  const words = useMemo(() => phraseFromEntropy(me.entropy), [me]);
  const [saved, setSaved] = useState<string | null>(null);
  const [pass, setPass] = useState('');
  const [showFile, setShowFile] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <View>
      <Text style={styles.h1}>Your recovery phrase</Text>
      <Text style={styles.body}>
        These 24 words are your account. Write them down and keep them somewhere safe. Anyone with them can read your
        rooms; without them, a lost phone means a lost account. Nobody, not even the server, can recover them for you.
      </Text>
      <View style={styles.words}>
        {words.map((w, i) => (
          <View key={i} style={styles.word}>
            <Text style={styles.wordNum}>{i + 1}</Text>
            <Text style={styles.wordText}>{w}</Text>
          </View>
        ))}
      </View>
      {!showFile ? (
        <Pressable style={styles.secondary} onPress={() => setShowFile(true)}>
          <Text style={styles.secondaryText}>Also save a key file…</Text>
        </Pressable>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>Key file passphrase</Text>
          <TextInput
            style={styles.input}
            value={pass}
            onChangeText={setPass}
            secureTextEntry
            placeholder="At least 8 characters"
            placeholderTextColor="#888"
          />
          <Pressable
            style={[styles.primary, (pass.length < 8 || busy) && styles.disabled]}
            disabled={pass.length < 8 || busy}
            onPress={async () => {
              setBusy(true);
              try {
                const json = await exportKeyFile(me, pass);
                setSaved(await saveTextFile('superchat-key.json', json));
              } catch (e) {
                setSaved(`Couldn't save: ${(e as Error).message}`);
              } finally {
                setBusy(false);
              }
            }}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Save key file</Text>}
          </Pressable>
          {saved && <Text style={styles.body}>{saved}</Text>}
        </View>
      )}
      <Pressable
        style={styles.primary}
        onPress={() => {
          // Three distinct random positions to ask back.
          const picks = new Set<number>();
          while (picks.size < 3) picks.add(randomBytes(1)[0] % 24);
          onNext([...picks].sort((a, b) => a - b));
        }}>
        <Text style={styles.primaryText}>I've written them down</Text>
      </Pressable>
    </View>
  );
}

function ConfirmPhrase({
  me,
  ask,
  styles,
  theme,
  busy,
  onBack,
  onOk,
}: {
  me: Identity;
  ask: number[];
  styles: Styles;
  theme: Theme;
  busy: boolean;
  onBack: () => void;
  onOk: () => void;
}) {
  const words = useMemo(() => phraseFromEntropy(me.entropy), [me]);
  const [answers, setAnswers] = useState<string[]>(ask.map(() => ''));
  const ok = ask.every((n, i) => answers[i].trim().toLowerCase() === words[n]);
  return (
    <View>
      <Text style={styles.h1}>Check your phrase</Text>
      <Text style={styles.body}>Type these words from your phrase to make sure you have it right.</Text>
      {ask.map((n, i) => (
        <View key={n} style={styles.field}>
          <Text style={styles.label}>Word {n + 1}</Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            value={answers[i]}
            onChangeText={t => setAnswers(a => a.map((x, j) => (j === i ? t : x)))}
            placeholderTextColor={theme.textMuted}
          />
        </View>
      ))}
      <Pressable style={[styles.primary, (!ok || busy) && styles.disabled]} disabled={!ok || busy} onPress={onOk}>
        {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={styles.primaryText}>Continue</Text>}
      </Pressable>
      <Pressable style={styles.secondary} onPress={onBack}>
        <Text style={styles.secondaryText}>Show the words again</Text>
      </Pressable>
    </View>
  );
}

function ImportPhrase({
  styles,
  theme,
  busy,
  onBack,
  onOk,
}: {
  styles: Styles;
  theme: Theme;
  busy: boolean;
  onBack: () => void;
  onOk: (phrase: string) => void;
}) {
  const [text, setText] = useState('');
  const count = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <View>
      <Text style={styles.h1}>Recovery phrase</Text>
      <Text style={styles.body}>Enter your 24 words in order, separated by spaces.</Text>
      <TextInput
        style={[styles.input, styles.phraseInput]}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        value={text}
        onChangeText={setText}
        placeholderTextColor={theme.textMuted}
        placeholder="word word word …"
      />
      <Text style={styles.hint}>{count} / 24 words</Text>
      <Pressable style={[styles.primary, (count !== 24 || busy) && styles.disabled]} disabled={count !== 24 || busy} onPress={() => onOk(text)}>
        {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={styles.primaryText}>Restore account</Text>}
      </Pressable>
      <Pressable style={styles.secondary} onPress={onBack}>
        <Text style={styles.secondaryText}>Back</Text>
      </Pressable>
    </View>
  );
}

export function PassphraseForm({
  title,
  hint,
  confirm,
  styles,
  theme,
  busy,
  onBack,
  onOk,
}: {
  title: string;
  hint: string;
  confirm: boolean;
  styles: Styles;
  theme: Theme;
  busy: boolean;
  onBack?: () => void;
  onOk: (pass: string) => void;
}) {
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const ok = confirm ? pass.length >= 8 && pass === again : pass.length > 0;
  return (
    <View>
      <Text style={styles.h1}>{title}</Text>
      <Text style={styles.body}>{hint}</Text>
      <TextInput
        style={styles.input}
        secureTextEntry
        value={pass}
        onChangeText={setPass}
        placeholder={confirm ? 'At least 8 characters' : 'Passphrase'}
        placeholderTextColor={theme.textMuted}
        onSubmitEditing={() => ok && !confirm && onOk(pass)}
      />
      {confirm && (
        <TextInput
          style={[styles.input, styles.spaced]}
          secureTextEntry
          value={again}
          onChangeText={setAgain}
          placeholder="Again"
          placeholderTextColor={theme.textMuted}
        />
      )}
      <Pressable style={[styles.primary, (!ok || busy) && styles.disabled]} disabled={!ok || busy} onPress={() => onOk(pass)}>
        {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={styles.primaryText}>Continue</Text>}
      </Pressable>
      {onBack && (
        <Pressable style={styles.secondary} onPress={onBack}>
          <Text style={styles.secondaryText}>Back</Text>
        </Pressable>
      )}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

export function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    content: {
      padding: 20,
      paddingTop: Platform.OS === 'web' ? 48 : 32,
      maxWidth: 520,
      width: '100%',
      alignSelf: 'center',
    },
    center: {
      alignItems: 'center',
    },
    h1: {
      fontSize: 22,
      fontWeight: '800',
      color: theme.text,
      marginBottom: 8,
    },
    lead: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.text,
      textAlign: 'center',
      marginTop: 20,
    },
    body: {
      fontSize: 14,
      lineHeight: 20,
      color: theme.textMuted,
      marginVertical: 10,
    },
    hint: {
      fontSize: 12,
      color: theme.textMuted,
      marginTop: 4,
    },
    words: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginVertical: 12,
    },
    word: {
      width: '31%',
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 8,
      borderRadius: 6,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
    },
    wordNum: {
      fontSize: 10,
      color: theme.textMuted,
      fontWeight: '700',
      width: 16,
    },
    wordText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.text,
      fontFamily: 'monospace',
    },
    card: {
      padding: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surface,
      marginTop: 8,
    },
    field: {
      marginTop: 10,
    },
    label: {
      fontSize: 12,
      fontWeight: '700',
      color: theme.textMuted,
      marginBottom: 4,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: theme.text,
      backgroundColor: theme.surface,
      fontSize: 15,
    },
    spaced: {
      marginTop: 8,
    },
    phraseInput: {
      minHeight: 120,
      textAlignVertical: 'top',
      fontFamily: 'monospace',
    },
    primary: {
      alignSelf: 'stretch',
      marginTop: 16,
      paddingVertical: 13,
      borderRadius: 8,
      backgroundColor: theme.primary,
      alignItems: 'center',
    },
    primaryText: {
      color: theme.primaryText,
      fontWeight: '700',
      fontSize: 15,
    },
    secondary: {
      alignSelf: 'stretch',
      marginTop: 10,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: theme.surfaceAlt,
      alignItems: 'center',
    },
    secondaryText: {
      color: theme.text,
      fontWeight: '600',
    },
    disabled: {
      opacity: 0.5,
    },
    error: {
      color: theme.danger,
      marginTop: 12,
      fontWeight: '600',
    },
  });
}
