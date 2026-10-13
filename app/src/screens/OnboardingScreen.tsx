import React, {useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {Icon} from '../components/Icon';
import {Notice} from '../components/Notice';
import {
  checkKeyFile,
  entropyFromPhrase,
  exportKeyFile,
  Identity,
  identityFromEntropy,
  importKeyFile,
  newIdentity,
  phraseFromEntropy,
  randomBytes,
} from '../crypto';
import {pickTextFile, saveTextFileAs} from '../files';
import {NEEDS_PASSPHRASE, storeIdentity} from '../keystore';
import {LogoArt} from '../logo/LogoArt';
import {Theme, useTheme} from '../theme';

type Step =
  | {name: 'welcome'}
  | {name: 'show'; me: Identity}
  | {name: 'confirm'; me: Identity; ask: number[]}
  | {name: 'importPhrase'}
  | {name: 'importFile'; json: string; file: string}
  | {name: 'restored'; me: Identity; how: string}
  | {name: 'protect'; me: Identity; back: Step};

/** Where Back goes from each step (null: leave the app as usual). */
function previous(step: Step): Step | null {
  switch (step.name) {
    case 'welcome':
      return null;
    case 'show':
    case 'importPhrase':
    case 'importFile':
    case 'restored':
      return {name: 'welcome'};
    case 'confirm':
      return {name: 'show', me: step.me};
    case 'protect':
      return step.back;
  }
}

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
  const [busy, setBusy] = useState<string | null>(null);

  const go = (s: Step) => {
    setError(null);
    setBusy(null);
    setStep(s);
  };
  const back = previous(step);

  // Android's back button walks back through the steps instead of closing
  // the app (it's ignored while something is in progress).
  useEffect(() => {
    if (!back) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy) go(back);
      return true;
    });
    return () => sub.remove();
  }, [back, busy]);

  const finish = async (me: Identity, passphrase?: string) => {
    setBusy('Saving your key on this device…');
    setError(null);
    try {
      await storeIdentity(me.entropy, passphrase);
      onDone(me.entropy);
    } catch (e) {
      setBusy(null);
      setError((e as Error).message);
    }
  };
  const store = (me: Identity, from: Step) => (NEEDS_PASSPHRASE ? go({name: 'protect', me, back: from}) : finish(me));

  const pickKeyFile = async () => {
    setError(null);
    try {
      const picked = await pickTextFile();
      if (!picked) return; // cancelled
      checkKeyFile(picked.text);
      go({name: 'importFile', json: picked.text, file: picked.name});
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {back && (
        <Pressable style={styles.backRow} onPress={() => !busy && go(back)} hitSlop={8} accessibilityLabel="Back">
          <Icon name="chevron-left" size={18} color={theme.textMuted} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
      )}

      {step.name === 'welcome' && (
        <View style={styles.center}>
          <LogoArt height={220} />
          <Text style={styles.lead}>End-to-end encrypted rooms. No sign-up, no phone number, no email.</Text>
          <Text style={styles.body}>
            Your account is a key that lives on this device. Servers store only ciphertext and never learn who you
            are.
          </Text>
          <Pressable style={styles.primary} onPress={() => go({name: 'show', me: newIdentity()})}>
            <Text style={styles.primaryText}>Create a new account</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => go({name: 'importPhrase'})}>
            <Text style={styles.secondaryText}>I have a recovery phrase</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={pickKeyFile}>
            <Text style={styles.secondaryText}>Import a key file</Text>
          </Pressable>
          {error && (
            <Notice kind="error" title="Couldn't use that file">
              {error}
            </Notice>
          )}
        </View>
      )}

      {step.name === 'show' && (
        <ShowPhrase
          me={step.me}
          styles={styles}
          theme={theme}
          busy={busy}
          onQuiz={ask => go({name: 'confirm', me: step.me, ask})}
          onSkipQuiz={() => store(step.me, step)}
        />
      )}

      {step.name === 'confirm' && (
        <ConfirmPhrase
          me={step.me}
          ask={step.ask}
          styles={styles}
          theme={theme}
          busy={!!busy}
          onBack={() => go({name: 'show', me: step.me})}
          onOk={() => store(step.me, step)}
        />
      )}

      {step.name === 'importPhrase' && (
        <ImportPhrase
          styles={styles}
          theme={theme}
          error={error}
          onOk={phrase => {
            try {
              go({name: 'restored', me: identityFromEntropy(entropyFromPhrase(phrase)), how: 'recovery phrase'});
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      )}

      {step.name === 'importFile' && (
        <PassphraseForm
          title="Unlock key file"
          hint={`Enter the passphrase you chose when you saved ${step.file}.`}
          confirm={false}
          styles={styles}
          theme={theme}
          busy={busy}
          error={error}
          submitLabel="Unlock"
          onOk={async pass => {
            setBusy('Unlocking… this takes a few seconds.');
            setError(null);
            try {
              const me = await importKeyFile(step.json, pass);
              go({name: 'restored', me, how: 'key file'});
            } catch (e) {
              setBusy(null);
              setError((e as Error).message);
            }
          }}
        />
      )}

      {step.name === 'restored' && (
        <View>
          <Notice kind="success" title="Account restored">
            Unlocked from your {step.how}. Your rooms are found again from each server once you continue.
          </Notice>
          <Text style={styles.hint}>Account fingerprint on this device: {step.me.id.slice(0, 12)}</Text>
          <Pressable style={[styles.primary, !!busy && styles.disabled]} disabled={!!busy} onPress={() => store(step.me, step)}>
            {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={styles.primaryText}>Continue</Text>}
          </Pressable>
          {busy && <Notice kind="working" title={busy} />}
          {error && (
            <Notice kind="error" title="Couldn't save your key">
              {error}
            </Notice>
          )}
        </View>
      )}

      {step.name === 'protect' && (
        <PassphraseForm
          title="Protect this browser"
          hint="Your key is kept in this browser encrypted with a passphrase. You'll enter it each time you open Super Chat here."
          confirm
          styles={styles}
          theme={theme}
          busy={busy}
          error={error}
          onOk={pass => finish(step.me, pass)}
        />
      )}

      {error && step.name !== 'welcome' && step.name !== 'importFile' && step.name !== 'importPhrase' && step.name !== 'restored' && step.name !== 'protect' && (
        <Notice kind="error" title="Something went wrong">
          {error}
        </Notice>
      )}
    </ScrollView>
  );
}

type SaveState = {kind: 'working'} | {kind: 'saved'; name: string; location: string} | {kind: 'error'; message: string};

function ShowPhrase({
  me,
  styles,
  theme,
  busy,
  onQuiz,
  onSkipQuiz,
}: {
  me: Identity;
  styles: Styles;
  theme: Theme;
  /** Set while the key is being stored after Continue. */
  busy: string | null;
  onQuiz: (ask: number[]) => void;
  onSkipQuiz: () => void;
}) {
  const words = useMemo(() => phraseFromEntropy(me.entropy), [me]);
  const [save, setSave] = useState<SaveState | null>(null);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [showFile, setShowFile] = useState(false);
  const saved = save?.kind === 'saved';
  const passOk = pass.length >= 8 && pass === again;

  const saveKeyFile = async () => {
    setSave({kind: 'working'});
    try {
      const file = await saveTextFileAs('superchat-key.json', () => exportKeyFile(me, pass));
      setSave(file ? {kind: 'saved', ...file} : null);
    } catch (e) {
      setSave({kind: 'error', message: (e as Error).message});
    }
  };

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

      {!showFile && !saved ? (
        <Pressable style={styles.secondary} onPress={() => setShowFile(true)}>
          <Text style={styles.secondaryText}>Also save a key file…</Text>
        </Pressable>
      ) : !saved ? (
        <View style={styles.card}>
          <Text style={styles.label}>Key file passphrase</Text>
          <TextInput
            style={styles.input}
            value={pass}
            onChangeText={setPass}
            secureTextEntry
            placeholder="At least 8 characters"
            placeholderTextColor={theme.textMuted}
          />
          <TextInput
            style={[styles.input, styles.spaced]}
            value={again}
            onChangeText={setAgain}
            secureTextEntry
            placeholder="Again"
            placeholderTextColor={theme.textMuted}
          />
          {again.length > 0 && pass !== again && <Text style={styles.fieldError}>The passphrases don't match.</Text>}
          <Pressable
            style={[styles.primary, (!passOk || save?.kind === 'working') && styles.disabled]}
            disabled={!passOk || save?.kind === 'working'}
            onPress={saveKeyFile}>
            <Text style={styles.primaryText}>Save key file</Text>
          </Pressable>
          {save?.kind === 'working' && <Notice kind="working" title="Encrypting and saving… this takes a few seconds." />}
          {save?.kind === 'error' && (
            <Notice kind="error" title="The key file wasn't saved">
              {save.message}
            </Notice>
          )}
        </View>
      ) : null}

      {save?.kind === 'saved' && (
        <Notice kind="success" title="Key file saved">
          {save.name} is in {save.location}. Move a copy off this phone (a USB stick, another device). It's only
          useful together with its passphrase.
        </Notice>
      )}

      <Pressable
        style={[styles.primary, !!busy && styles.disabled]}
        disabled={!!busy}
        onPress={() => {
          if (saved) {
            // The key file is a tested backup already; no quiz needed.
            onSkipQuiz();
            return;
          }
          // Three distinct random positions to ask back.
          const picks = new Set<number>();
          while (picks.size < 3) picks.add(randomBytes(1)[0] % 24);
          onQuiz([...picks].sort((a, b) => a - b));
        }}>
        {busy ? (
          <ActivityIndicator color={theme.primaryText} />
        ) : (
          <Text style={styles.primaryText}>{saved ? 'Continue' : "I've written them down"}</Text>
        )}
      </Pressable>
      {busy && <Notice kind="working" title={busy} />}
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
      <Text style={styles.body}>
        Type these words from your phrase to make sure you have it right. (Saving a key file on the previous screen
        skips this.)
      </Text>
      {ask.map((n, i) => {
        const typed = answers[i].trim().toLowerCase();
        const wrong = typed.length >= words[n].length && typed !== words[n];
        return (
          <View key={n} style={styles.field}>
            <Text style={styles.label}>Word {n + 1}</Text>
            <TextInput
              style={[styles.input, wrong && styles.inputError]}
              autoCapitalize="none"
              autoCorrect={false}
              value={answers[i]}
              onChangeText={t => setAnswers(a => a.map((x, j) => (j === i ? t : x)))}
              placeholderTextColor={theme.textMuted}
            />
            {wrong && <Text style={styles.fieldError}>That's not word {n + 1}.</Text>}
          </View>
        );
      })}
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
  error,
  onOk,
}: {
  styles: Styles;
  theme: Theme;
  error: string | null;
  onOk: (phrase: string) => void;
}) {
  const [text, setText] = useState('');
  const count = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <View>
      <Text style={styles.h1}>Recovery phrase</Text>
      <Text style={styles.body}>Enter your 24 words in order, separated by spaces.</Text>
      <TextInput
        style={[styles.input, styles.phraseInput, !!error && styles.inputError]}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        value={text}
        onChangeText={setText}
        placeholderTextColor={theme.textMuted}
        placeholder="word word word …"
      />
      <Text style={styles.hint}>{count} / 24 words</Text>
      {error && (
        <Notice kind="error" title="That phrase didn't work">
          {error}
        </Notice>
      )}
      <Pressable style={[styles.primary, count !== 24 && styles.disabled]} disabled={count !== 24} onPress={() => onOk(text)}>
        <Text style={styles.primaryText}>Restore account</Text>
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
  error,
  submitLabel = 'Continue',
  onBack,
  onOk,
}: {
  title: string;
  hint: string;
  confirm: boolean;
  styles: Styles;
  theme: Theme;
  /** A message while working (or a plain true for no message). */
  busy: string | boolean | null;
  error?: string | null;
  submitLabel?: string;
  onBack?: () => void;
  onOk: (pass: string) => void;
}) {
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const ok = confirm ? pass.length >= 8 && pass === again : pass.length > 0;
  const submit = () => ok && !busy && onOk(pass);
  return (
    <View>
      <Text style={styles.h1}>{title}</Text>
      <Text style={styles.body}>{hint}</Text>
      <TextInput
        style={[styles.input, !!error && styles.inputError]}
        secureTextEntry
        value={pass}
        onChangeText={setPass}
        editable={!busy}
        placeholder={confirm ? 'At least 8 characters' : 'Passphrase'}
        placeholderTextColor={theme.textMuted}
        onSubmitEditing={() => !confirm && submit()}
      />
      {confirm && (
        <TextInput
          style={[styles.input, styles.spaced]}
          secureTextEntry
          value={again}
          onChangeText={setAgain}
          editable={!busy}
          placeholder="Again"
          placeholderTextColor={theme.textMuted}
        />
      )}
      {confirm && again.length > 0 && pass !== again && <Text style={styles.fieldError}>The passphrases don't match.</Text>}
      {error && (
        <Notice kind="error" title="That didn't work">
          {error}
        </Notice>
      )}
      {typeof busy === 'string' && <Notice kind="working" title={busy} />}
      <Pressable style={[styles.primary, (!ok || !!busy) && styles.disabled]} disabled={!ok || !!busy} onPress={submit}>
        {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={styles.primaryText}>{submitLabel}</Text>}
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
    inputError: {
      borderColor: theme.danger,
    },
    fieldError: {
      color: theme.danger,
      fontSize: 12,
      marginTop: 4,
    },
    backRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      alignSelf: 'flex-start',
      marginBottom: 12,
      paddingVertical: 4,
    },
    backText: {
      color: theme.textMuted,
      fontSize: 14,
      fontWeight: '600',
    },
  });
}
