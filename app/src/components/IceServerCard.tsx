// A STUN/TURN server shared in a chat: a card in the message bubble, and a
// sheet that shows the server, tests it, and adds it to this device's voice
// servers (Settings → Voice) once the test passes.
import React, {useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {describeIce, sharedEntry, alreadyAdded} from '../call/iceShare';
import type {IceServerEntry} from '../call/iceConfig';
import {testIceServer} from '../call/testIce';
import {settingsStore} from '../settings';
import {Theme, useTheme} from '../theme';
import {Icon} from './Icon';
import {Overlay} from './Overlay';

export function IceServerCard({
  server,
  mine,
  sharedBy,
  color,
}: {
  server: unknown;
  mine: boolean;
  sharedBy: string;
  color: string;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const entry = sharedEntry(server);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(settingsStore.get().iceServers);
  useEffect(() => settingsStore.subscribe(s => setList(s.iceServers)), []);

  if (!entry) {
    return (
      <Text style={[styles.cardSub, {color}]}>
        🔒 A voice server that couldn't be read
      </Text>
    );
  }
  const d = describeIce(entry);
  const added = alreadyAdded(entry, list);
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Icon name="volume-2" size={16} color={color} />
        <Text style={[styles.cardTitle, {color}]}>
          {mine
            ? `You shared a ${d.kind} server`
            : `${d.kind} server for voice`}
        </Text>
      </View>
      <Text style={[styles.cardSub, {color}]} numberOfLines={1}>
        {d.host}
        {d.transport ? ` · ${d.transport}` : ''}
        {d.tls ? ' · TLS' : ''}
      </Text>
      <Pressable
        style={[styles.cardBtn, {borderColor: color}]}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={added ? 'View voice server' : 'Add voice server'}>
        <Text style={[styles.cardBtnText, {color}]}>
          {added ? 'Added ✓ · View' : mine ? 'View' : 'Add'}
        </Text>
      </Pressable>
      {open ? (
        <AddSheet
          entry={entry}
          sharedBy={mine ? 'you' : sharedBy}
          added={added}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

type TestState =
  | {state: 'testing'}
  | {state: 'done'; ok: boolean; message: string};

function AddSheet({
  entry,
  sharedBy,
  added,
  onClose,
}: {
  entry: IceServerEntry;
  sharedBy: string;
  added: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const d = describeIce(entry);
  const [reveal, setReveal] = useState(false);
  const [test, setTest] = useState<TestState>({state: 'testing'});
  const run = useRef(0);

  const runTest = async () => {
    const n = ++run.current;
    setTest({state: 'testing'});
    const r = await testIceServer(entry);
    if (n === run.current)
      setTest({state: 'done', ok: r.ok, message: r.message});
  };
  // Tested as soon as it's opened: only a working server can be added.
  useEffect(() => {
    runTest();
    // Closing the sheet drops a test still running.
    const runs = run;
    return () => {
      runs.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const passed = test.state === 'done' && test.ok;
  const add = async () => {
    if (!passed || added) return;
    const list = settingsStore.get().iceServers;
    if (!alreadyAdded(entry, list))
      await settingsStore.update({iceServers: [...list, entry]});
    onClose();
  };

  const row = (label: string, value: React.ReactNode) => (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValue}>
        {typeof value === 'string' ? (
          <Text style={styles.value}>{value}</Text>
        ) : (
          value
        )}
      </View>
    </View>
  );

  return (
    <Overlay visible modal onClose={onClose} style={styles.layer}>
      <View style={styles.sheet}>
        <Text style={styles.title}>{d.kind} server</Text>
        <Text style={styles.hint}>Shared by {sharedBy}</Text>
        {row('Address', d.host)}
        {row('URL', entry.urls)}
        {d.kind === 'TURN' ? row('Transport', d.transport || 'Auto') : null}
        {d.tls ? row('TLS', 'Yes') : null}
        {entry.username ? row('Username', entry.username) : null}
        {entry.credential
          ? row(
              'Password',
              <View style={styles.pwRow}>
                <Text style={[styles.value, styles.flex]} selectable={reveal}>
                  {reveal
                    ? entry.credential
                    : '•'.repeat(Math.min(12, entry.credential.length))}
                </Text>
                <Pressable onPress={() => setReveal(r => !r)} hitSlop={8}>
                  <Text style={[styles.link, {color: theme.primary}]}>
                    {reveal ? 'Hide' : 'Show'}
                  </Text>
                </Pressable>
              </View>,
            )
          : null}

        <View style={styles.testLine}>
          {test.state === 'testing' ? (
            <>
              <ActivityIndicator size="small" color={theme.textMuted} />
              <Text style={styles.hint}>Testing…</Text>
            </>
          ) : (
            <Text
              style={[
                styles.hint,
                {color: test.ok ? theme.success : theme.danger},
              ]}>
              {test.message}
            </Text>
          )}
        </View>

        <Text style={styles.hint}>
          Only add relays from people you trust: a relay sees your IP address
          while you're in voice (never what's said, which stays end-to-end
          encrypted). It's saved on this device only, under Settings → Voice.
        </Text>

        <View style={styles.buttons}>
          <Pressable style={styles.btn} onPress={onClose}>
            <Text style={styles.btnText}>{added ? 'Close' : 'Cancel'}</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, test.state === 'testing' && styles.disabled]}
            disabled={test.state === 'testing'}
            onPress={runTest}>
            <Text style={styles.btnText}>Test</Text>
          </Pressable>
          {!added ? (
            <Pressable
              style={[
                styles.btn,
                {backgroundColor: theme.primary},
                !passed && styles.disabled,
              ]}
              disabled={!passed}
              onPress={add}
              accessibilityHint={
                passed ? undefined : 'Available once the test passes'
              }>
              <Text style={[styles.btnText, {color: theme.primaryText}]}>
                Add
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Overlay>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    flex: {flex: 1},
    card: {gap: 4, minWidth: 200},
    cardHead: {flexDirection: 'row', alignItems: 'center', gap: 6},
    cardTitle: {fontSize: 14, fontWeight: '700'},
    cardSub: {fontSize: 13, opacity: 0.85},
    cardBtn: {
      alignSelf: 'flex-start',
      marginTop: 6,
      borderWidth: 1,
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    cardBtnText: {fontSize: 12, fontWeight: '700'},
    layer: {justifyContent: 'center', alignItems: 'center', padding: 20},
    sheet: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: theme.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.border,
      padding: 18,
      gap: 8,
    },
    title: {fontSize: 16, fontWeight: '700', color: theme.text},
    hint: {fontSize: 12, color: theme.textMuted, lineHeight: 17},
    row: {flexDirection: 'row', gap: 10, alignItems: 'center'},
    rowLabel: {
      width: 82,
      fontSize: 12,
      fontWeight: '600',
      color: theme.textMuted,
    },
    rowValue: {flex: 1, minWidth: 0},
    value: {fontSize: 13, color: theme.text},
    pwRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
    link: {fontSize: 12, fontWeight: '700'},
    testLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      minHeight: 22,
      marginTop: 4,
    },
    buttons: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 6,
    },
    btn: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: theme.surfaceAlt,
    },
    btnText: {fontSize: 13, fontWeight: '600', color: theme.text},
    disabled: {opacity: 0.45},
  });
}
