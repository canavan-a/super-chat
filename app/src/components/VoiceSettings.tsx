// Settings → Voice: the STUN/TURN servers this device uses for voice (an
// editable list, which may be empty), the chat server's relay, and relay-only
// mode. These stay on this device: they're never synced or sent to anyone.
import React, {useEffect, useState} from 'react';
import {
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
  isTurnUrl,
  settingsCoverage,
  validateIceUrl,
  type IceServerEntry,
} from '../call/iceConfig';
import {testIceServer} from '../call/testIce';
import {platformConfirm} from '../platformConfirm';
import {settingsStore} from '../settings';
import {Theme, useTheme} from '../theme';
import {AMBER} from './VoiceBar';

interface Draft {
  /** Index being edited, or -1 for a new server. */
  index: number;
  urls: string;
  username: string;
  credential: string;
}

export function VoiceSettings(): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const [s, setS] = useState(settingsStore.get());
  useEffect(() => settingsStore.subscribe(setS), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [tests, setTests] = useState<
    Record<string, {busy: boolean; ok?: boolean; message?: string}>
  >({});

  const list = s.iceServers;
  const setList = (iceServers: IceServerEntry[]) =>
    settingsStore.update({iceServers});
  const coverage = settingsCoverage(s);
  const hasTurn = coverage === 'turn' || s.useServerRelay;

  const status =
    coverage === 'turn'
      ? {color: theme.success, text: 'TURN configured ✓'}
      : coverage === 'stun-only'
      ? {
          color: AMBER,
          text: s.useServerRelay
            ? "STUN only on this device. The chat server's relay is used if it has one; otherwise some connections will fail."
            : 'STUN only: some connections will fail (e.g. on mobile data). Add a TURN server.',
        }
      : {
          color: s.useServerRelay ? AMBER : theme.danger,
          text: s.useServerRelay
            ? "No servers on this device: voice relies on the chat server's relay, if it has one."
            : 'No servers: voice only works on the same network.',
        };

  const save = () => {
    if (!draft) return;
    const urls = draft.urls.trim();
    const bad = validateIceUrl(urls);
    if (bad) {
      setDraftError(bad);
      return;
    }
    const turn = isTurnUrl(urls);
    const prev = draft.index >= 0 ? list[draft.index] : undefined;
    const entry: IceServerEntry = turn
      ? {
          urls,
          username: draft.username.trim() || undefined,
          // Left blank while editing: keep the saved password.
          credential:
            draft.credential ||
            (prev && prev.urls ? prev.credential : undefined),
        }
      : {urls};
    if (turn && (!entry.username || !entry.credential)) {
      setDraftError('TURN servers need a username and password');
      return;
    }
    const next = [...list];
    if (draft.index >= 0) next[draft.index] = entry;
    else next.push(entry);
    setList(next);
    setDraft(null);
    setDraftError(null);
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
              onPress={() => {
                setDraftError(null);
                setDraft({
                  index: i,
                  urls: e.urls,
                  username: e.username ?? '',
                  credential: '',
                });
              }}>
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
              onPress={() => {
                setDraftError(null);
                setDraft({
                  index: i,
                  urls: e.urls,
                  username: e.username ?? '',
                  credential: '',
                });
              }}>
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

      {draft ? (
        <View style={styles.form}>
          <Text style={styles.label}>
            {draft.index >= 0 ? 'Edit server' : 'Add server'}
          </Text>
          <TextInput
            style={styles.input}
            value={draft.urls}
            onChangeText={urls => setDraft({...draft, urls})}
            placeholder="turns:turn.example.com:443?transport=tcp"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {isTurnUrl(draft.urls) ? (
            <>
              <TextInput
                style={styles.input}
                value={draft.username}
                onChangeText={username => setDraft({...draft, username})}
                placeholder="Username"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={styles.input}
                value={draft.credential}
                onChangeText={credential => setDraft({...draft, credential})}
                placeholder={
                  draft.index >= 0
                    ? 'Password (leave blank to keep)'
                    : 'Password'
                }
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
              <Text style={styles.hint}>
                People you talk to will see this relay's IP address, so pick one
                that isn't tied to you if that matters. Prefer turns: (TLS),
                which keeps the username off the network.
              </Text>
            </>
          ) : null}
          {draftError ? (
            <Text style={[styles.hint, {color: theme.danger}]}>
              {draftError}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              style={styles.btn}
              onPress={() => {
                setDraft(null);
                setDraftError(null);
              }}>
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, {backgroundColor: theme.primary}]}
              onPress={save}>
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
            onPress={() => {
              setDraftError(null);
              setDraft({index: -1, urls: '', username: '', credential: ''});
            }}>
            <Text style={styles.btnText}>Add server</Text>
          </Pressable>
          {list.length ? (
            <Pressable
              style={styles.btn}
              onPress={() =>
                platformConfirm(
                  'Delete all servers?',
                  'Remove every STUN and TURN server from this device? Voice will then only connect on the same network (or through the chat server’s relay, if it has one).',
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
          <Text style={styles.label}>
            Use the chat server's relay when available
          </Text>
          <Text style={styles.hint}>
            Your chat server may offer its own TURN relay, with credentials that
            expire.
          </Text>
        </View>
        <Switch
          value={s.useServerRelay}
          onValueChange={v => settingsStore.update({useServerRelay: v})}
        />
      </View>
      <View style={styles.switchRow}>
        <View style={styles.flex}>
          <Text style={styles.label}>Relay all voice (hide IP)</Text>
          <Text style={styles.hint}>
            {hasTurn
              ? 'Always go through a TURN relay, so people you talk to never see your IP address. Uses more of the relay.'
              : 'Needs a TURN server (yours, or the chat server’s).'}
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
    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginTop: 16,
    },
  });
}
