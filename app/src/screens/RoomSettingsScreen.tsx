import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Clipboard, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View} from 'react-native';

import type {HeaderInfo} from '../App';
import {fingerprint} from '../crypto';
import {Avatar} from '../components/Avatar';
import {Icon} from '../components/Icon';
import {platformConfirm} from '../platformConfirm';
import {Route} from '../routes';
import {
  getRoom,
  kick,
  leave,
  makeInvite,
  revokeInvite,
  ROOM_COLORS,
  setDisplayName,
  setMeta,
  setRetention,
  setRole,
  useStore,
  wipeChat,
} from '../store';
import {Theme, useTheme} from '../theme';

const RETENTION_PRESETS = [
  {days: 1, label: '1 day'},
  {days: 7, label: '7 days'},
  {days: 30, label: '30 days'},
  {days: 90, label: '90 days'},
  {days: 365, label: '1 year'},
  {days: 0, label: 'Forever'},
];

const EXPIRY_PRESETS = [
  {ms: 60 * 60_000, label: '1 hour'},
  {ms: 24 * 60 * 60_000, label: '1 day'},
  {ms: 7 * 24 * 60 * 60_000, label: '7 days'},
  {ms: 0, label: 'Never'},
];

const USES_PRESETS = [
  {n: 1, label: '1 use'},
  {n: 5, label: '5 uses'},
  {n: 25, label: '25 uses'},
  {n: 0, label: 'Unlimited'},
];

// Links made this session. The secret in a link is never stored anywhere,
// so once you leave this screen a link can be tracked and revoked but not
// shown again.
const freshLinks = new Map<string, string>();

export function RoomSettingsScreen({
  roomKey,
  onNavigate,
  onHeaderChange,
}: {
  roomKey: string;
  onNavigate: (route: Route) => void;
  onHeaderChange: (info: HeaderInfo | null) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const room = useStore(() => getRoom(roomKey));
  const meId = room?.me.id ?? '';
  const view = room?.view;
  const isAdmin = !!view?.members.find(m => m.id === meId && m.role === 'admin');

  const [name, setName] = useState(view?.name ?? '');
  const [color, setColor] = useState(view?.color ?? ROOM_COLORS[0]);
  const [myName, setMyName] = useState(view?.names[meId] ?? '');
  const [expiry, setExpiry] = useState(EXPIRY_PRESETS[1].ms);
  const [uses, setUses] = useState(USES_PRESETS[0].n);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    onHeaderChange({
      title: view?.name ?? 'Room',
      subtitle: 'Room settings',
      accentColor: view?.color ?? undefined,
      actions: [{label: 'Back to chat', icon: 'close', onPress: () => onNavigate({name: 'room', key: roomKey})}],
    });
  }, [view?.name, view?.color, roomKey, onHeaderChange, onNavigate]);

  if (!room || !view) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.textMuted} />
      </View>
    );
  }

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();
  const inviteStatus = (iv: (typeof view.invites)[number]) =>
    iv.revoked
      ? 'Revoked'
      : iv.expiresAt && now > iv.expiresAt
        ? 'Expired'
        : iv.maxUses && iv.uses >= iv.maxUses
          ? 'Used up'
          : 'Active';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {error && <Text style={styles.error}>{error}</Text>}

      {isAdmin && (
        <Section title="Invite" styles={styles}>
          <Text style={styles.help}>
            Anyone with the link can join until it expires, runs out of uses, or you revoke it. They'll only see
            messages sent after they join.
          </Text>
          <Text style={styles.label}>Expires</Text>
          <Chips options={EXPIRY_PRESETS.map(p => ({key: p.ms, label: p.label}))} value={expiry} onChange={setExpiry} styles={styles} />
          <Text style={styles.label}>Uses</Text>
          <Chips options={USES_PRESETS.map(p => ({key: p.n, label: p.label}))} value={uses} onChange={setUses} styles={styles} />
          <Pressable
            style={[styles.primary, busy === 'invite' && styles.disabled]}
            disabled={busy === 'invite'}
            onPress={() =>
              run('invite', async () => {
                const l = await makeInvite(roomKey, {expiresAt: expiry ? Date.now() + expiry : 0, maxUses: uses});
                const id = l.split('/i/')[1]?.split('#')[0];
                if (id) freshLinks.set(id, l);
                setLink(l);
              })
            }>
            {busy === 'invite' ? <ActivityIndicator color={theme.primaryText} /> : <Text style={styles.primaryText}>Create invite link</Text>}
          </Pressable>
          {link && (
            <View style={styles.linkBox}>
              <Text style={styles.linkText} selectable>
                {link}
              </Text>
              <View style={styles.linkActions}>
                <Pressable style={styles.secondary} onPress={() => Clipboard.setString(link)}>
                  <Icon name="copy" size={14} color={theme.text} />
                  <Text style={styles.secondaryText}>Copy</Text>
                </Pressable>
                <Pressable style={styles.secondary} onPress={() => Share.share({message: link}).catch(() => {})}>
                  <Icon name="link" size={14} color={theme.text} />
                  <Text style={styles.secondaryText}>Share</Text>
                </Pressable>
              </View>
              <Text style={styles.help}>This link won't be shown again once you leave this screen.</Text>
            </View>
          )}
        </Section>
      )}

      {isAdmin && view.invites.length > 0 && (
        <Section title="Invite links" styles={styles}>
          {view.invites.map(iv => {
            const status = inviteStatus(iv);
            return (
              <View key={iv.id} style={styles.inviteRow}>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>
                    {status} · {iv.uses}
                    {iv.maxUses ? `/${iv.maxUses}` : ''} used
                  </Text>
                  <Text style={styles.rowSub}>
                    By {view.names[iv.creator] ?? fingerprint(iv.creator)} · {new Date(iv.createdAt).toLocaleDateString()}
                    {iv.expiresAt ? ` · expires ${new Date(iv.expiresAt).toLocaleString()}` : ''}
                  </Text>
                  {iv.joined.length > 0 && (
                    <Text style={styles.rowSub}>Joined: {iv.joined.map(id => view.names[id] ?? fingerprint(id)).join(', ')}</Text>
                  )}
                </View>
                {freshLinks.has(iv.id) && status === 'Active' && (
                  <Pressable style={styles.iconButton} onPress={() => Clipboard.setString(freshLinks.get(iv.id)!)}>
                    <Icon name="copy" size={16} color={theme.text} />
                  </Pressable>
                )}
                {status === 'Active' && (
                  <Pressable
                    style={styles.dangerButton}
                    onPress={() =>
                      platformConfirm('Revoke invite?', 'Nobody will be able to join with this link again.', 'Revoke', () =>
                        run('revoke', () => revokeInvite(roomKey, iv.id)),
                      )
                    }>
                    <Text style={styles.dangerButtonText}>Revoke</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </Section>
      )}

      <Section title={`Members (${view.members.length})`} styles={styles}>
        {view.members.map(m => (
          <View key={m.id} style={styles.memberRow}>
            <Avatar roomKey={roomKey} member={m.id} name={m.name} size={34} />
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>
                {m.name ?? 'Unnamed'}
                {m.id === meId ? ' (you)' : ''}
              </Text>
              <Text style={styles.mono}>{fingerprint(m.id)}</Text>
            </View>
            <Text style={[styles.role, m.role === 'admin' && styles.roleAdmin]}>{m.role}</Text>
            {isAdmin && m.id !== meId && (
              <View style={styles.memberActions}>
                <Pressable
                  style={styles.smallButton}
                  onPress={() => run('role', () => setRole(roomKey, m.id, m.role === 'admin' ? 'member' : 'admin'))}>
                  <Text style={styles.smallButtonText}>{m.role === 'admin' ? 'Demote' : 'Make admin'}</Text>
                </Pressable>
                <Pressable
                  style={styles.dangerButton}
                  onPress={() =>
                    platformConfirm(
                      'Remove member?',
                      `${m.name ?? 'They'} will be removed and the room's key replaced, so they can't read anything sent after this.`,
                      'Remove',
                      () => run('kick', () => kick(roomKey, m.id)),
                    )
                  }>
                  <Text style={styles.dangerButtonText}>Remove</Text>
                </Pressable>
              </View>
            )}
          </View>
        ))}
      </Section>

      <Section title="Your name in this room" styles={styles}>
        <View style={styles.inline}>
          <TextInput
            style={[styles.input, styles.flex]}
            value={myName}
            onChangeText={setMyName}
            maxLength={40}
            placeholder="Display name"
            placeholderTextColor={theme.textMuted}
          />
          <Pressable
            style={[styles.saveButton, (!myName.trim() || busy === 'name') && styles.disabled]}
            disabled={!myName.trim() || busy === 'name'}
            onPress={() => run('name', () => setDisplayName(roomKey, myName.trim()))}>
            <Text style={styles.primaryText}>Save</Text>
          </Pressable>
        </View>
        <Text style={styles.help}>Encrypted: only members see it.</Text>
      </Section>

      {isAdmin && (
        <Section title="Room" styles={styles}>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            maxLength={80}
            placeholder="Room name"
            placeholderTextColor={theme.textMuted}
          />
          <View style={styles.swatches}>
            {ROOM_COLORS.map(c => (
              <Pressable key={c} onPress={() => setColor(c)} style={[styles.swatch, {backgroundColor: c}, color === c && styles.swatchOn]} />
            ))}
          </View>
          <Pressable
            style={[styles.primary, (!name.trim() || busy === 'meta') && styles.disabled]}
            disabled={!name.trim() || busy === 'meta'}
            onPress={() => run('meta', () => setMeta(roomKey, name.trim(), color))}>
            <Text style={styles.primaryText}>Save name and color</Text>
          </Pressable>
        </Section>
      )}

      <Section title="Message retention" styles={styles}>
        <Text style={styles.help}>
          {view.retentionDays
            ? `Messages and files are deleted from the server and every device after ${view.retentionDays} day${view.retentionDays === 1 ? '' : 's'}.`
            : 'Messages are kept until someone deletes them.'}
        </Text>
        {isAdmin && (
          <Chips
            options={RETENTION_PRESETS.map(p => ({key: p.days, label: p.label}))}
            value={view.retentionDays}
            onChange={d => run('retention', () => setRetention(roomKey, d))}
            styles={styles}
          />
        )}
      </Section>

      <Section title="Security" styles={styles}>
        <Text style={styles.help}>
          Key generation {view.epoch}. The key is replaced whenever someone joins, leaves or is removed. Everyone in
          the room verifies every membership change themselves; the server can't add anyone.
        </Text>
        <Text style={styles.help}>Server: {room.server}</Text>
      </Section>

      {isAdmin && (
        <Pressable
          style={[styles.leaveButton, styles.wipeButton]}
          onPress={() =>
            platformConfirm(
              'Wipe chat history?',
              'Every message and attachment in this room is deleted for everyone, permanently. Members, settings and invite links stay. The chat will show that you wiped it.',
              'Wipe',
              () =>
                run('wipe', async () => {
                  await wipeChat(roomKey);
                  onNavigate({name: 'room', key: roomKey});
                }),
            )
          }>
          <Text style={styles.leaveText}>Wipe chat history</Text>
        </Pressable>
      )}

      <Pressable
        style={[styles.leaveButton]}
        onPress={() =>
          platformConfirm(
            'Leave room?',
            isAdmin && view.members.filter(m => m.role === 'admin').length === 1 && view.members.length > 1
              ? "You're the only admin. Make someone else admin first, or nobody will be able to invite or manage members."
              : "You'll lose access to this room and its messages on this device.",
            'Leave',
            () =>
              run('leave', async () => {
                await leave(roomKey);
                onNavigate({name: 'home'});
              }),
          )
        }>
        <Text style={styles.leaveText}>Leave room</Text>
      </Pressable>
    </ScrollView>
  );
}

function Section({title, styles, children}: {title: string; styles: Styles; children: React.ReactNode}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Chips<K extends number>({
  options,
  value,
  onChange,
  styles,
}: {
  options: {key: K; label: string}[];
  value: K;
  onChange: (k: K) => void;
  styles: Styles;
}) {
  return (
    <View style={styles.chips}>
      {options.map(o => (
        <Pressable key={o.key} style={[styles.chip, o.key === value && styles.chipOn]} onPress={() => onChange(o.key)}>
          <Text style={[styles.chipText, o.key === value && styles.chipTextOn]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    content: {padding: 16, paddingBottom: 48, maxWidth: 640, width: '100%', alignSelf: 'center'},
    center: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg},
    flex: {flex: 1, minWidth: 0},
    error: {color: theme.danger, fontWeight: '600', marginBottom: 12},
    section: {
      marginBottom: 16,
      padding: 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surface,
    },
    sectionTitle: {fontSize: 13, fontWeight: '800', color: theme.text, marginBottom: 8, textTransform: 'uppercase'},
    help: {fontSize: 12, color: theme.textMuted, lineHeight: 17, marginBottom: 6},
    label: {fontSize: 12, fontWeight: '700', color: theme.textMuted, marginTop: 6, marginBottom: 4},
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: theme.text,
      backgroundColor: theme.bg,
      fontSize: 15,
    },
    inline: {flexDirection: 'row', gap: 8, alignItems: 'center'},
    chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4},
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.bg,
    },
    chipOn: {borderColor: theme.primary, backgroundColor: theme.primary},
    chipText: {fontSize: 12, fontWeight: '600', color: theme.text},
    chipTextOn: {color: theme.primaryText},
    primary: {marginTop: 10, paddingVertical: 11, borderRadius: 8, backgroundColor: theme.primary, alignItems: 'center'},
    primaryText: {color: theme.primaryText, fontWeight: '700'},
    saveButton: {paddingVertical: 9, paddingHorizontal: 14, borderRadius: 6, backgroundColor: theme.primary},
    disabled: {opacity: 0.5},
    secondary: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 6,
      backgroundColor: theme.surfaceAlt,
    },
    secondaryText: {color: theme.text, fontWeight: '600', fontSize: 13},
    linkBox: {marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.border},
    linkText: {fontFamily: 'monospace', fontSize: 12, color: theme.text},
    linkActions: {flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 6},
    inviteRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.border},
    memberRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.border},
    memberActions: {flexDirection: 'row', gap: 6},
    rowTitle: {fontSize: 14, fontWeight: '600', color: theme.text},
    rowSub: {fontSize: 11, color: theme.textMuted, marginTop: 1},
    mono: {fontSize: 11, color: theme.textMuted, fontFamily: 'monospace', marginTop: 1},
    role: {fontSize: 11, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase'},
    roleAdmin: {color: theme.primary},
    iconButton: {padding: 6},
    smallButton: {paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.surfaceAlt},
    smallButtonText: {fontSize: 12, fontWeight: '600', color: theme.text},
    dangerButton: {paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.dangerBg},
    dangerButtonText: {fontSize: 12, fontWeight: '700', color: theme.danger},
    swatches: {flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10},
    swatch: {width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'transparent'},
    swatchOn: {borderColor: theme.text},
    leaveButton: {paddingVertical: 12, borderRadius: 8, backgroundColor: theme.dangerBg, alignItems: 'center'},
    leaveText: {color: theme.danger, fontWeight: '700'},
    wipeButton: {marginBottom: 10},
  });
}
