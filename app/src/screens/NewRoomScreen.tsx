import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';

import {parseInviteLink} from '../crypto';
import {Route} from '../routes';
import {settingsStore} from '../settings';
import {createRoom, join, JoinPreview, previewInvite, ROOM_COLORS} from '../store';
import {Theme, useTheme} from '../theme';

export function NewRoomScreen({onNavigate}: {onNavigate: (route: Route) => void}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const s = settingsStore.get();
  const [name, setName] = useState('');
  const [color, setColor] = useState(ROOM_COLORS[Math.floor(Math.random() * 5)]);
  const [displayName, setDisplayName] = useState(s.displayName);
  const [retention, setRetention] = useState(30);
  const [server, setServer] = useState(s.defaultServer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ok = name.trim() && displayName.trim() && server.trim();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!s.displayName) await settingsStore.update({displayName: displayName.trim()});
      const key = await createRoom(server, name.trim(), color, retention, displayName.trim());
      onNavigate({name: 'room', key});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Room name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} maxLength={80} placeholder="e.g. Family" placeholderTextColor={theme.textMuted} />
      <View style={styles.swatches}>
        {ROOM_COLORS.map(c => (
          <Pressable key={c} onPress={() => setColor(c)} style={[styles.swatch, {backgroundColor: c}, color === c && styles.swatchOn]} />
        ))}
      </View>

      <Text style={styles.label}>Your name in this room</Text>
      <TextInput
        style={styles.input}
        value={displayName}
        onChangeText={setDisplayName}
        maxLength={40}
        placeholder="What others will see"
        placeholderTextColor={theme.textMuted}
      />

      <Text style={styles.label}>Delete messages after</Text>
      <View style={styles.chips}>
        {[1, 7, 30, 90, 365, 0].map(d => (
          <Pressable key={d} style={[styles.chip, retention === d && styles.chipOn]} onPress={() => setRetention(d)}>
            <Text style={[styles.chipText, retention === d && styles.chipTextOn]}>{d === 0 ? 'Never' : d === 365 ? '1 year' : `${d} day${d === 1 ? '' : 's'}`}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Server</Text>
      <TextInput style={styles.input} value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} placeholderTextColor={theme.textMuted} />
      <Text style={styles.help}>The server stores the room's ciphertext. It can't read names, messages or files.</Text>

      <Pressable style={[styles.primary, (!ok || busy) && styles.disabled]} disabled={!ok || busy} onPress={submit}>
        {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={styles.primaryText}>Create room</Text>}
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

export function JoinScreen({link: initial, onNavigate}: {link?: string; onNavigate: (route: Route) => void}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [text, setText] = useState(initial ?? '');
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [displayName, setDisplayName] = useState(settingsStore.get().displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseInviteLink(text);
  useEffect(() => {
    setPreview(null);
    setError(null);
    const l = parseInviteLink(text);
    if (!l) return;
    let live = true;
    setBusy(true);
    previewInvite(l)
      .then(p => live && setPreview(p))
      .catch(e => live && setError((e as Error).message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [text]);

  const doJoin = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      if (!settingsStore.get().displayName) await settingsStore.update({displayName: displayName.trim()});
      const key = await join(preview.link, displayName.trim());
      onNavigate({name: 'room', key});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Invite link</Text>
      <TextInput
        style={[styles.input, styles.linkInput]}
        value={text}
        onChangeText={setText}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        placeholder="https://chat.superbadger.io/i/…#…"
        placeholderTextColor={theme.textMuted}
      />
      {text.trim() !== '' && !parsed && <Text style={styles.error}>That doesn't look like a Super Chat invite link.</Text>}
      {busy && !preview && <ActivityIndicator style={styles.spinner} color={theme.textMuted} />}

      {preview && (
        <View style={[styles.card, {borderLeftColor: preview.color || theme.primary}]}>
          <Text style={styles.cardTitle}>{preview.name || 'Encrypted room'}</Text>
          <Text style={styles.help}>
            {preview.inviter ? `${preview.inviter} invited you · ` : ''}
            {preview.members} member{preview.members === 1 ? '' : 's'} · {preview.link.server.replace(/^https?:\/\//, '')}
          </Text>
          {preview.alreadyMember ? (
            <Pressable style={styles.primary} onPress={doJoin}>
              <Text style={styles.primaryText}>You're already in this room. Open it</Text>
            </Pressable>
          ) : (
            <>
              <Text style={styles.label}>Your name in this room</Text>
              <TextInput
                style={styles.input}
                value={displayName}
                onChangeText={setDisplayName}
                maxLength={40}
                placeholder="What others will see"
                placeholderTextColor={theme.textMuted}
              />
              <Text style={styles.help}>You'll see messages sent from now on, not the room's earlier history.</Text>
              <Pressable
                style={[styles.primary, (!displayName.trim() || busy) && styles.disabled]}
                disabled={!displayName.trim() || busy}
                onPress={doJoin}>
                {busy ? <ActivityIndicator color={theme.primaryText} /> : <Text style={styles.primaryText}>Join room</Text>}
              </Pressable>
            </>
          )}
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

export function HomeScreen({onNavigate}: {onNavigate: (route: Route) => void}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={[styles.container, styles.homeCenter]}>
      <Text style={styles.cardTitle}>No room open</Text>
      <Text style={[styles.help, styles.centerText]}>Rooms are invite-only. Start one, or paste an invite link someone sent you.</Text>
      <Pressable style={[styles.primary, styles.homeButton]} onPress={() => onNavigate({name: 'newRoom'})}>
        <Text style={styles.primaryText}>+ New Room</Text>
      </Pressable>
      <Pressable style={[styles.secondary, styles.homeButton]} onPress={() => onNavigate({name: 'join'})}>
        <Text style={styles.secondaryText}>Join via link</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    content: {padding: 16, paddingBottom: 48, maxWidth: 560, width: '100%', alignSelf: 'center'},
    label: {fontSize: 12, fontWeight: '700', color: theme.textMuted, marginTop: 14, marginBottom: 6},
    help: {fontSize: 12, color: theme.textMuted, lineHeight: 17, marginTop: 6},
    centerText: {textAlign: 'center', maxWidth: 320},
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
    linkInput: {minHeight: 70, fontFamily: 'monospace', fontSize: 13, textAlignVertical: 'top'},
    swatches: {flexDirection: 'row', gap: 10, marginTop: 10},
    swatch: {width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'transparent'},
    swatchOn: {borderColor: theme.text},
    chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
    chip: {paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface},
    chipOn: {borderColor: theme.primary, backgroundColor: theme.primary},
    chipText: {fontSize: 12, fontWeight: '600', color: theme.text},
    chipTextOn: {color: theme.primaryText},
    primary: {marginTop: 18, paddingVertical: 12, borderRadius: 8, backgroundColor: theme.primary, alignItems: 'center'},
    primaryText: {color: theme.primaryText, fontWeight: '700'},
    secondary: {marginTop: 10, paddingVertical: 12, borderRadius: 8, backgroundColor: theme.surfaceAlt, alignItems: 'center'},
    secondaryText: {color: theme.text, fontWeight: '600'},
    disabled: {opacity: 0.5},
    error: {color: theme.danger, fontWeight: '600', marginTop: 12},
    spinner: {marginTop: 16},
    card: {
      marginTop: 16,
      padding: 14,
      borderRadius: 10,
      borderWidth: 1,
      borderLeftWidth: 4,
      borderColor: theme.border,
      backgroundColor: theme.surface,
    },
    cardTitle: {fontSize: 18, fontWeight: '800', color: theme.text},
    homeCenter: {alignItems: 'center', justifyContent: 'center', padding: 24},
    homeButton: {alignSelf: 'center', maxWidth: 320, width: '100%'},
  });
}
