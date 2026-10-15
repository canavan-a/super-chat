// Settings → Voice → Share: send one of this device's STUN/TURN servers,
// credentials included, to a chat as an end-to-end encrypted message. The
// chat's members get a card they can add it from (IceServerCard).
import React, {useState} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {IceServerEntry} from '../call/iceConfig';
import {describeIce} from '../call/iceShare';
import {platformConfirm} from '../platformConfirm';
import {roomList, send, useStore} from '../store';
import {Theme, useTheme} from '../theme';
import {ChatAvatar} from './ChatAvatar';
import {Overlay} from './Overlay';

/** How many recent chats the sheet lists. */
const RECENT = 25;

export function IceShareSheet({
  entry,
  onClose,
}: {
  entry: IceServerEntry;
  onClose: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const rooms = useStore(() => roomList().slice(0, RECENT));
  const d = describeIce(entry);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ok: boolean; text: string} | null>(
    null,
  );

  const shareTo = (key: string, name: string) => {
    const creds = entry.username
      ? ' Everyone in it will be able to use your relay with its username and password.'
      : '';
    platformConfirm(
      `Share with ${name}?`,
      `Share the ${d.kind} server ${d.host} with ${name}?${creds}`,
      'Share',
      async () => {
        setBusy(key);
        try {
          await send(key, {t: 'ice', server: entry});
          setStatus({ok: true, text: `Shared with ${name}`});
          setTimeout(onClose, 900);
        } catch (e) {
          setStatus({
            ok: false,
            text: `Couldn't share: ${(e as Error).message}`,
          });
        } finally {
          setBusy(null);
        }
      },
      false,
    );
  };

  return (
    <Overlay visible modal onClose={onClose} style={styles.layer}>
      <View style={styles.sheet}>
        <Text style={styles.title}>Share {d.kind} server</Text>
        <Text style={styles.hint} numberOfLines={1}>
          {entry.urls}
        </Text>
        <Text style={styles.hint}>
          Sent as an encrypted message: only the chat's members can read it.
          {entry.username ? ' It includes the username and password.' : ''}
        </Text>
        {status ? (
          <Text
            style={[
              styles.status,
              {color: status.ok ? theme.success : theme.danger},
            ]}>
            {status.text}
          </Text>
        ) : null}
        <FlatList
          style={styles.list}
          data={rooms}
          keyExtractor={r => r.key}
          ListEmptyComponent={<Text style={styles.hint}>No chats yet.</Text>}
          renderItem={({item}) => (
            <Pressable
              style={({pressed}) => [
                styles.row,
                pressed && {backgroundColor: theme.surfaceAlt},
              ]}
              disabled={busy !== null}
              onPress={() => shareTo(item.key, item.name)}
              accessibilityRole="button"
              accessibilityLabel={`Share with ${item.name}`}>
              <ChatAvatar
                roomKey={item.key}
                picture={item.picture}
                color={item.color}
                size={36}
              />
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              {busy === item.key ? (
                <ActivityIndicator size="small" color={theme.textMuted} />
              ) : null}
            </Pressable>
          )}
        />
        <View style={styles.buttons}>
          <Pressable style={styles.btn} onPress={onClose}>
            <Text style={styles.btnText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Overlay>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    layer: {justifyContent: 'center', alignItems: 'center', padding: 20},
    sheet: {
      width: '100%',
      maxWidth: 420,
      maxHeight: '85%',
      backgroundColor: theme.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.border,
      padding: 18,
      gap: 6,
    },
    title: {fontSize: 16, fontWeight: '700', color: theme.text},
    hint: {fontSize: 12, color: theme.textMuted, lineHeight: 17},
    status: {fontSize: 13, fontWeight: '600'},
    // Shrinks to fit the sheet, and scrolls, when there are many chats.
    list: {marginTop: 6, flexGrow: 0, flexShrink: 1},
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 8,
      paddingHorizontal: 6,
      borderRadius: 8,
    },
    name: {flex: 1, fontSize: 14, fontWeight: '600', color: theme.text},
    buttons: {flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8},
    btn: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: theme.surfaceAlt,
    },
    btnText: {fontSize: 13, fontWeight: '600', color: theme.text},
  });
}
