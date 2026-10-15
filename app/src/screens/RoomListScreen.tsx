import React, {useMemo, useRef, useState} from 'react';
import {Alert, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';

import {voiceSummary} from '../call/engine';
import {roomVoice, useVoice} from '../call/voice';
import {ChatAvatar} from '../components/ChatAvatar';
import {Icon} from '../components/Icon';
import {Overlay} from '../components/Overlay';
import {PixelField} from '../components/PixelField';
import {SpringyPull} from '../components/SpringyPull';
import {tick} from '../haptics';
import {platformConfirm} from '../platformConfirm';
import {Route} from '../routes';
import {getRoom, leave, refreshAll, RoomListItem, useStore} from '../store';
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
  const scrollY = useRef(0);
  const showServer = new Set(rooms.map(r => r.server)).size > 1;
  useVoice();
  // Rooms with someone in voice: how many others, and whether we are.
  const inVoice = useStore(() =>
    Object.fromEntries(
      rooms.map(r => {
        const v = roomVoice(r.key);
        return [r.key, {others: v.others.length, mine: v.mine}];
      }),
    ),
  );

  // Long-press a chat: a menu offering to leave it (with the same
  // confirmation, and only-admin warning, as the room settings).
  const [menuFor, setMenuFor] = useState<RoomListItem | null>(null);
  const confirmLeave = (item: RoomListItem) => {
    setMenuFor(null);
    const view = getRoom(item.key)?.view;
    const admins = view?.members.filter(m => m.role === 'admin') ?? [];
    const lastAdmin =
      !!view && view.members.length > 1 && admins.length === 1 && admins[0].id === getRoom(item.key)!.me.id;
    platformConfirm(
      `Leave ${item.name}?`,
      lastAdmin
        ? "You're the only admin. Make someone else admin first, or nobody will be able to invite or manage members."
        : "You'll lose access to this room and its messages on this device.",
      'Leave',
      () => leave(item.key).catch(e => Alert.alert("Couldn't leave", (e as Error).message || String(e))),
    );
  };

  const go = (route: Route) => {
    setAddOpen(false);
    onNavigate(route);
  };

  return (
    <View style={styles.container}>
      {/* No loading screen: the list is up from the start (from last launch's
          rooms when there are any), pull-to-refresh works throughout, and
          rows fill in as they load. */}
      <SpringyPull atTop={() => scrollY.current <= 0} onRefresh={refreshAll} background={() => <PixelField />}>
        <FlatList
          data={rooms}
          keyExtractor={r => r.key}
          onScroll={e => (scrollY.current = e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={32}
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
                onPress={() => onNavigate({name: 'room', key: item.key})}
                onLongPress={() => {
                  tick();
                  setMenuFor(item);
                }}>
                <ChatAvatar roomKey={item.key} picture={item.picture} color={item.color} size={44} />
                <View style={styles.rowBody}>
                  <View style={styles.rowTop}>
                    <Text style={[styles.rowTitle, unread && styles.rowTitleUnread]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    {inVoice[item.key]?.others || inVoice[item.key]?.mine ? (
                      <View
                        style={styles.voiceBadge}
                        accessibilityLabel={voiceSummary(inVoice[item.key].others, inVoice[item.key].mine)}>
                        <Icon name="volume-2" size={12} color={theme.success} />
                        {/* How many others; just the icon when it's only you. */}
                        {inVoice[item.key].others ? (
                          <Text style={styles.voiceBadgeText}>
                            {inVoice[item.key].mine ? `You + ${inVoice[item.key].others}` : inVoice[item.key].others}
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
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
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            loading ? (
              // First ever load (nothing remembered yet): faint placeholder rows.
              <View>
                {[0.55, 0.4, 0.48].map((w, i) => (
                  <View key={i} style={styles.skeletonRow}>
                    <View style={[styles.skeletonBar, {width: `${w * 100}%`}]} />
                    <View style={[styles.skeletonBar, styles.skeletonBarThin]} />
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.center}>
                <Text style={styles.emptyTitle}>No chats yet</Text>
                <Text style={styles.muted}>Chats are invite-only. Tap + to start one, or join with an invite link.</Text>
              </View>
            )
          }
        />
      </SpringyPull>

      <Pressable
        style={({pressed}) => [styles.fab, pressed && styles.fabPressed]}
        onPress={() => setAddOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="New chat or join">
        <Icon name="plus" size={26} color={theme.primaryText} />
      </Pressable>

      <Overlay visible={addOpen} onClose={() => setAddOpen(false)} style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <Pressable style={styles.sheetRow} onPress={() => go({name: 'newRoom'})}>
            <Icon name="plus" size={18} color={theme.text} />
            <Text style={styles.sheetText}>New chat</Text>
          </Pressable>
          <Pressable style={styles.sheetRow} onPress={() => go({name: 'join'})}>
            <Icon name="link" size={18} color={theme.text} />
            <Text style={styles.sheetText}>Join via link</Text>
          </Pressable>
        </View>
      </Overlay>

      <Overlay visible={menuFor !== null} onClose={() => setMenuFor(null)} style={styles.menuBackdrop}>
        <View style={styles.sheet}>
          <Text style={styles.menuTitle} numberOfLines={1}>
            {menuFor?.name}
          </Text>
          <Pressable style={styles.sheetRow} onPress={() => menuFor && confirmLeave(menuFor)}>
            <Icon name="close" size={18} color={theme.danger} />
            <Text style={[styles.sheetText, styles.dangerText]}>Leave chat</Text>
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
    voiceBadge: {flexDirection: 'row', alignItems: 'center', gap: 3, marginRight: 8},
    voiceBadgeText: {fontSize: 11, fontWeight: '700', color: theme.success},
    container: {flex: 1, backgroundColor: theme.bg},
    center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32},
    skeletonRow: {paddingHorizontal: 16, paddingVertical: 16, gap: 8, borderBottomWidth: 1, borderBottomColor: theme.border},
    skeletonBar: {height: 12, borderRadius: 6, backgroundColor: theme.surfaceAlt, opacity: 0.6},
    skeletonBarThin: {height: 9, width: '75%', opacity: 0.35},
    muted: {color: theme.textMuted, textAlign: 'center', maxWidth: 320},
    emptyTitle: {fontSize: 18, fontWeight: '800', color: theme.text},
    emptyContent: {flexGrow: 1},
    // Room for the + button under the last row.
    listContent: {paddingBottom: 96},
    row: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      // Room color accent, the same treatment super-badger gives stations.
      borderLeftWidth: 4,
    },
    rowBody: {flex: 1, minWidth: 0},
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
    // A chat's long-press menu: centered, titled with the chat.
    menuBackdrop: {justifyContent: 'center', alignItems: 'center', padding: 32},
    menuTitle: {
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 8,
      fontSize: 13,
      fontWeight: '700',
      color: theme.textMuted,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    dangerText: {color: theme.danger},
  });
}
