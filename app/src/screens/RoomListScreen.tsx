import React, {useMemo, useState} from 'react';
import {ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';

import {Icon} from '../components/Icon';
import {Overlay} from '../components/Overlay';
import {Route} from '../routes';
import {RoomListItem} from '../store';
import {Theme, useTheme} from '../theme';

/**
 * The main screen: every room, most recently active first, and a floating +
 * that offers a new room or joining by link. (It replaced the slide-out
 * drawer.)
 */
export function RoomListScreen({
  rooms,
  loading,
  onNavigate,
}: {
  rooms: RoomListItem[];
  loading: boolean;
  onNavigate: (route: Route) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [addOpen, setAddOpen] = useState(false);
  const showServer = new Set(rooms.map(r => r.server)).size > 1;

  const go = (route: Route) => {
    setAddOpen(false);
    onNavigate(route);
  };

  return (
    <View style={styles.container}>
      {loading && rooms.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.textMuted} />
          <Text style={styles.muted}>Loading your rooms…</Text>
        </View>
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={r => r.key}
          contentContainerStyle={rooms.length === 0 ? styles.emptyContent : styles.listContent}
          renderItem={({item}) => {
            // Unread: bold, the preview in full color, a count badge, and a
            // tinted row. Caught up: plain, with a muted preview.
            const unread = item.unread || item.unreadCount > 0;
            return (
              <Pressable
                style={({pressed}) => [
                  styles.row,
                  {borderLeftColor: item.color},
                  unread && styles.rowUnread,
                  pressed && styles.rowPressed,
                ]}
                onPress={() => onNavigate({name: 'room', key: item.key})}>
                <View style={styles.rowTop}>
                  <Text style={[styles.rowTitle, unread && styles.rowTitleUnread]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={[styles.rowTime, unread && styles.rowTimeUnread]}>
                    {item.lastAt ? timeAgo(item.lastAt) : ''}
                  </Text>
                </View>
                <View style={styles.rowBottom}>
                  <Text style={[styles.rowPreview, unread && styles.rowPreviewUnread]} numberOfLines={1}>
                    {showServer ? item.server.replace(/^https?:\/\//, '') + ' · ' : ''}
                    {item.preview ?? (unread ? 'New messages' : 'No messages yet')}
                  </Text>
                  {unread && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>
                        {item.unreadCount > 0 ? (item.unreadCount > 99 ? '99+' : item.unreadCount) : ''}
                      </Text>
                    </View>
                  )}
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>No rooms yet</Text>
              <Text style={styles.muted}>Rooms are invite-only. Tap + to start one, or join with an invite link.</Text>
            </View>
          }
        />
      )}

      <Pressable
        style={({pressed}) => [styles.fab, pressed && styles.fabPressed]}
        onPress={() => setAddOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="New room or join">
        <Icon name="plus" size={26} color={theme.primaryText} />
      </Pressable>

      <Overlay visible={addOpen} onClose={() => setAddOpen(false)} style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <Pressable style={styles.sheetRow} onPress={() => go({name: 'newRoom'})}>
            <Icon name="plus" size={18} color={theme.text} />
            <Text style={styles.sheetText}>New room</Text>
          </Pressable>
          <Pressable style={styles.sheetRow} onPress={() => go({name: 'join'})}>
            <Icon name="link" size={18} color={theme.text} />
            <Text style={styles.sheetText}>Join via link</Text>
          </Pressable>
        </View>
      </Overlay>
    </View>
  );
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32},
    muted: {color: theme.textMuted, textAlign: 'center', maxWidth: 320},
    emptyTitle: {fontSize: 18, fontWeight: '800', color: theme.text},
    emptyContent: {flexGrow: 1},
    // Room for the + button under the last row.
    listContent: {paddingBottom: 96},
    row: {
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      // Room color accent, the same treatment super-badger gives stations.
      borderLeftWidth: 4,
    },
    rowUnread: {backgroundColor: theme.surface},
    rowPressed: {backgroundColor: theme.surfaceAlt},
    rowTop: {flexDirection: 'row', alignItems: 'baseline', gap: 8},
    rowTitle: {flex: 1, fontSize: 15, fontWeight: '500', color: theme.text},
    rowTitleUnread: {fontWeight: '800'},
    rowTime: {fontSize: 11, color: theme.textMuted},
    rowTimeUnread: {color: theme.primary, fontWeight: '700'},
    rowBottom: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3},
    rowPreview: {flex: 1, fontSize: 13, color: theme.textMuted},
    rowPreviewUnread: {color: theme.text, fontWeight: '600'},
    badge: {
      minWidth: 20,
      height: 20,
      paddingHorizontal: 6,
      borderRadius: 10,
      backgroundColor: theme.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: {fontSize: 11, fontWeight: '800', color: theme.primaryText},
    fab: {
      position: 'absolute',
      right: 20,
      bottom: 24,
      width: 58,
      height: 58,
      borderRadius: 29,
      backgroundColor: theme.primary,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 6,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 6,
      shadowOffset: {width: 0, height: 3},
    },
    fabPressed: {opacity: 0.85},
    // The menu opens just above the + button.
    sheetBackdrop: {justifyContent: 'flex-end', alignItems: 'flex-end', paddingRight: 20, paddingBottom: 92},
    sheet: {
      minWidth: 200,
      borderRadius: 12,
      paddingVertical: 6,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
    },
    sheetRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14},
    sheetText: {fontSize: 15, fontWeight: '600', color: theme.text},
  });
}
