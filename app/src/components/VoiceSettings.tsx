// Settings → Voice: the STUN/TURN servers this device uses for voice (an
// editable list, which may be empty: added by hand or from a server shared in
// a chat) and relay-only mode. These stay on this device: they're never synced or sent to anyone.
import React, {useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  DEFAULT_ICE_SERVERS,
  DEFAULT_STUN,
  EMPTY_ICE_FORM,
  entryFromForm,
  entryKey,
  iceFormFrom,
  isTurnUrl,
  settingsCoverage,
  defaultIcePort,
  type IceForm,
  type IceServerEntry,
  type TurnTransport,
} from '../call/iceConfig';
import {testIceServer} from '../call/testIce';
import {platformConfirm} from '../platformConfirm';
import {IceShareSheet} from './IceShareSheet';
import {settingsStore} from '../settings';
import {Theme, useTheme} from '../theme';
import {AMBER} from './VoiceBar';

interface Draft {
  /** Index being edited, or -1 for a new server. */
  index: number;
  form: IceForm;
}

/** How long typing has to pause before the form tests what's there. */
const AUTO_TEST_MS = 700;

type FormTest =
  | {state: 'idle'}
  | {state: 'testing'; key: string}
  | {state: 'done'; key: string; ok: boolean; message: string};

export function VoiceSettings(): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const [s, setS] = useState(settingsStore.get());
  useEffect(() => settingsStore.subscribe(setS), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formTest, setFormTest] = useState<FormTest>({state: 'idle'});
  const testRun = useRef(0);
  const [sharing, setSharing] = useState<IceServerEntry | null>(null);
  const [tests, setTests] = useState<
    Record<string, {busy: boolean; ok?: boolean; message?: string}>
  >({});

  const list = s.iceServers;
  const setList = (iceServers: IceServerEntry[]) =>
    settingsStore.update({iceServers});
  const coverage = settingsCoverage(s);
  const hasTurn = coverage === 'turn';

  const status =
    coverage === 'turn'
      ? {color: theme.success, text: 'TURN configured ✓'}
      : coverage === 'stun-only'
      ? {
          color: AMBER,
          text: 'STUN only: some connections will fail (e.g. on mobile data). Add a TURN server.',
        }
      : {
          color: theme.danger,
          text: 'No servers: voice only works on the same network.',
        };

  // The server the form currently describes (or what's still missing).
  const keep =
    draft && draft.index >= 0 ? list[draft.index]?.credential : undefined;
  const built = draft ? entryFromForm(draft.form, keep) : null;
  const draftEntry = built && 'entry' in built ? built.entry : null;
  const draftKey = draftEntry ? entryKey(draftEntry) : null;
  const passed =
    formTest.state === 'done' && formTest.ok && formTest.key === draftKey;

  const testDraft = async (entry: IceServerEntry) => {
    const run = ++testRun.current;
    const key = entryKey(entry);
    setFormTest({state: 'testing', key});
    const r = await testIceServer(entry);
    if (run === testRun.current)
      setFormTest({state: 'done', key, ok: r.ok, message: r.message});
  };

  // Test automatically once the form describes a complete server and typing
  // has paused; any change invalidates the last result.
  useEffect(() => {
    if (!draftEntry) {
      testRun.current++;
      setFormTest({state: 'idle'});
      return;
    }
    const t = setTimeout(() => testDraft(draftEntry), AUTO_TEST_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const openForm = (index: number, form: IceForm) => {
    testRun.current++;
    setFormTest({state: 'idle'});
    setDraft({index, form});
  };
  const closeForm = () => {
    testRun.current++;
    setDraft(null);
  };
  const setForm = (patch: Partial<IceForm>) => {
    if (draft) setDraft({...draft, form: {...draft.form, ...patch}});
  };

  const save = () => {
    if (!draft || !draftEntry || !passed) return;
    const next = [...list];
    if (draft.index >= 0) next[draft.index] = draftEntry;
    else next.push(draftEntry);
    setList(next);
    setTests(t => ({
      ...t,
      [draftEntry.urls]: {
        busy: false,
        ok: true,
        message: formTest.state === 'done' ? formTest.message : '',
      },
    }));
    closeForm();
  };

  const test = async (e: IceServerEntry) => {
    setTests(t => ({...t, [e.urls]: {busy: true}}));
    const r = await testIceServer(e);
    setTests(t => ({
      ...t,
      [e.urls]: {busy: false, ok: r.ok, message: r.message},
    }));
  };

  return (
    <View>
      <Text style={styles.title2}>Voice</Text>
      <Text style={styles.hint}>
        STUN and TURN servers help voice connect across networks. TURN relays
        the audio when a direct connection isn't possible; it can't hear
        anything, since voice is encrypted end to end. These stay on this
        device.
      </Text>

      <Text style={[styles.status, {color: status.color}]}>{status.text}</Text>

      {list.length === 0 ? (
        <Text style={styles.empty}>No STUN or TURN servers.</Text>
      ) : null}
      {list.map((e, i) => {
        const t = tests[e.urls];
        const turn = isTurnUrl(e.urls);
        return (
          <View key={`${e.urls}|${i}`} style={styles.row}>
            <Pressable
              style={styles.rowText}
              onPress={() => openForm(i, iceFormFrom(e))}>
              <View style={styles.rowTitle}>
                <View
                  style={[
                    styles.tag,
                    {borderColor: turn ? theme.success : theme.border},
                  ]}>
                  <Text
                    style={[
                      styles.tagText,
                      {color: turn ? theme.success : theme.textMuted},
                    ]}>
                    {turn ? 'TURN' : 'STUN'}
                  </Text>
                </View>
                <Text style={styles.url} numberOfLines={1}>
                  {e.urls}
                </Text>
              </View>
              {e.username ? (
                <Text style={styles.hint}>User: {e.username}</Text>
              ) : null}
              {e.urls === DEFAULT_STUN ? (
                <Text style={styles.hint}>
                  Google's public STUN server. Google sees your IP address when
                  you join voice.
                </Text>
              ) : null}
              {t ? (
                <Text
                  style={[
                    styles.hint,
                    t.ok === true && {color: theme.success},
                    t.ok === false && {color: theme.danger},
                  ]}>
                  {t.busy ? 'Testing…' : t.message}
                </Text>
              ) : null}
            </Pressable>
            <Pressable
              style={styles.btn}
              onPress={() => test(e)}
              disabled={t?.busy}>
              <Text style={styles.btnText}>Test</Text>
            </Pressable>
            <Pressable
              style={styles.btn}
              onPress={() => setSharing(e)}
              accessibilityLabel={`Share ${e.urls} to a chat`}>
              <Text style={styles.btnText}>Share</Text>
            </Pressable>
            <Pressable
              style={styles.btn}
              onPress={() => openForm(i, iceFormFrom(e))}>
              <Text style={styles.btnText}>Edit</Text>
            </Pressable>
            <Pressable
              style={styles.btn}
              onPress={() => setList(list.filter((_, j) => j !== i))}
              accessibilityLabel={`Delete ${e.urls}`}>
              <Text style={[styles.btnText, {color: theme.danger}]}>
                Delete
              </Text>
            </Pressable>
          </View>
        );
      })}

      {sharing ? (
        <IceShareSheet entry={sharing} onClose={() => setSharing(null)} />
      ) : null}

      {draft ? (
        <View style={styles.form}>
          <Text style={styles.label}>
            {draft.index >= 0 ? 'Edit server' : 'Add server'}
          </Text>
          <Segmented
            theme={theme}
            value={draft.form.kind}
            options={[
              {value: 'stun', label: 'STUN'},
              {value: 'turn', label: 'TURN'},
            ]}
            onChange={kind => setForm({kind})}
          />
          <Text style={styles.hint}>
            {draft.form.kind === 'stun'
              ? 'STUN lets each side find its public address. Free and light, but some networks still block direct connections.'
              : 'TURN relays the audio when a direct connection fails. It needs a username and password.'}
          </Text>
          <TextInput
            style={styles.input}
            value={draft.form.address}
            onChangeText={address => setForm({address})}
            placeholder={`${draft.form.kind}.example.com:${defaultIcePort(
              draft.form.tls,
            )}`}
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Server address"
          />
          <Text style={styles.hint}>
            Host name or IP (IPv6 in [brackets]). Port{' '}
            {defaultIcePort(draft.form.tls)} if left out. You can also paste a
            whole {draft.form.kind}: URL.
          </Text>
          {draft.form.tls ? (
            // Only from a pasted or saved stuns:/turns: URL; kept as it is.
            <Text style={styles.hint}>
              Uses TLS ({draft.form.kind}s:), from the URL.
            </Text>
          ) : null}
          {draft.form.kind === 'turn' ? (
            <>
              <Text style={styles.label}>Transport</Text>
              <Segmented
                theme={theme}
                value={draft.form.transport}
                options={[
                  {value: 'auto', label: 'Auto'},
                  {value: 'udp', label: 'UDP'},
                  {value: 'tcp', label: 'TCP'},
                ]}
                onChange={(transport: TurnTransport) => {
                  setForm({transport});
                }}
              />
              <Text style={styles.hint}>
                {draft.form.transport === 'auto'
                  ? 'No transport in the URL: most browsers and phones then use UDP. Add a TCP entry too for networks that block UDP.'
                  : draft.form.transport === 'udp'
                  ? 'UDP: lowest latency, but some networks block it.'
                  : 'TCP: for networks that block UDP.'}
              </Text>
              <TextInput
                style={styles.input}
                value={draft.form.username}
                onChangeText={username => setForm({username})}
                placeholder="Username"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Username"
              />
              <TextInput
                style={styles.input}
                value={draft.form.password}
                onChangeText={password => setForm({password})}
                placeholder={
                  draft.index >= 0 && keep
                    ? 'Password (leave blank to keep)'
                    : 'Password'
                }
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                accessibilityLabel="Password"
              />
              <Text style={styles.hint}>
                People you talk to will see this relay's IP address, so pick one
                that isn't tied to you if that matters.
              </Text>
            </>
          ) : null}

          <View style={styles.testLine}>
            {formTest.state === 'testing' && formTest.key === draftKey ? (
              <>
                <ActivityIndicator size="small" color={theme.textMuted} />
                <Text style={styles.hint}>Testing…</Text>
              </>
            ) : formTest.state === 'done' && formTest.key === draftKey ? (
              <Text
                style={[
                  styles.hint,
                  {color: formTest.ok ? theme.success : theme.danger},
                ]}>
                {formTest.message}
              </Text>
            ) : built &&
              'error' in built &&
              (draft.form.address ||
                draft.form.username ||
                draft.form.password) ? (
              <Text style={styles.hint}>{built.error}</Text>
            ) : (
              <Text style={styles.hint}>
                It's tested automatically once filled in; it can only be saved
                once it works.
              </Text>
            )}
          </View>

          <View style={styles.actions}>
            <Pressable style={styles.btn} onPress={closeForm}>
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, !draftEntry && styles.disabled]}
              disabled={
                !draftEntry ||
                (formTest.state === 'testing' && formTest.key === draftKey)
              }
              onPress={() => draftEntry && testDraft(draftEntry)}>
              <Text style={styles.btnText}>Test</Text>
            </Pressable>
            <Pressable
              style={[
                styles.btn,
                {backgroundColor: theme.primary},
                !passed && styles.disabled,
              ]}
              disabled={!passed}
              onPress={save}
              accessibilityHint={
                passed ? undefined : 'Available once the test passes'
              }>
              <Text style={[styles.btnText, {color: theme.primaryText}]}>
                Save
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Pressable
            style={styles.btn}
            onPress={() => openForm(-1, EMPTY_ICE_FORM)}>
            <Text style={styles.btnText}>Add server</Text>
          </Pressable>
          {list.length ? (
            <Pressable
              style={styles.btn}
              onPress={() =>
                platformConfirm(
                  'Delete all servers?',
                  'Remove every STUN and TURN server from this device? Voice will then only connect on the same network.',
                  'Delete all',
                  () => setList([]),
                )
              }>
              <Text style={[styles.btnText, {color: theme.danger}]}>
                Delete all
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            style={styles.btn}
            onPress={() => setList(DEFAULT_ICE_SERVERS)}>
            <Text style={styles.btnText}>Reset to default</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.switchRow}>
        <View style={styles.flex}>
          <Text style={styles.label}>Relay all voice (hide IP)</Text>
          <Text style={styles.hint}>
            {hasTurn
              ? 'Always go through a TURN relay, so people you talk to never see your IP address. Uses more of the relay.'
              : 'Needs a TURN server in the list above.'}
          </Text>
        </View>
        <Switch
          value={s.relayOnlyVoice && hasTurn}
          disabled={!hasTurn}
          onValueChange={v => settingsStore.update({relayOnlyVoice: v})}
        />
      </View>
    </View>
  );
}

function Segmented<T extends string>({
  theme,
  value,
  options,
  onChange,
}: {
  theme: Theme;
  value: T;
  options: {value: T; label: string}[];
  onChange: (v: T) => void;
}) {
  const styles = makeStyles(theme);
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup">
      {options.map(o => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            style={[styles.segment, on && {backgroundColor: theme.surface}]}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{selected: on}}>
            <Text style={[styles.segmentText, on && {color: theme.text}]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    flex: {flex: 1},
    title2: {
      fontSize: 15,
      fontWeight: '700',
      marginBottom: 4,
      color: theme.text,
    },
    hint: {fontSize: 12, color: theme.textMuted, marginTop: 4},
    status: {fontSize: 12, fontWeight: '600', marginTop: 10, marginBottom: 6},
    empty: {fontSize: 13, color: theme.textMuted, marginVertical: 10},
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    rowText: {flex: 1, minWidth: 0},
    rowTitle: {flexDirection: 'row', alignItems: 'center', gap: 6},
    tag: {
      borderWidth: 1,
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 1,
    },
    tagText: {fontSize: 10, fontWeight: '700'},
    url: {flex: 1, fontSize: 13, color: theme.text},
    btn: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 6,
      backgroundColor: theme.surfaceAlt,
    },
    btnText: {fontSize: 12, fontWeight: '600', color: theme.text},
    form: {marginTop: 12, gap: 8},
    label: {fontSize: 13, fontWeight: '600', color: theme.textMuted},
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 14,
      color: theme.text,
      backgroundColor: theme.surface,
    },
    actions: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12},
    disabled: {opacity: 0.45},
    testLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      minHeight: 22,
    },
    segmented: {
      flexDirection: 'row',
      gap: 4,
      padding: 3,
      borderRadius: 8,
      backgroundColor: theme.surfaceAlt,
      alignSelf: 'flex-start',
    },
    segment: {paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6},
    segmentText: {fontSize: 12, fontWeight: '700', color: theme.textMuted},
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginTop: 16,
    },
  });
}
