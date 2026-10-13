import React from 'react';
import {ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';

import {Route} from '../routes';
import {RoomListItem} from '../store';
import {Theme, useTheme} from '../theme';
import {Icon} from './Icon';

/** The sidebar: rooms the way super-badger lists stations. */
export function RoomsDrawerContent({
  rooms,
  loading,
  activeKey,
  onNavigate,
}: {
  rooms: RoomListItem[];
  loading: boolean;
  activeKey: string | null;
  onNavigate: (route: Route) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const servers = new Set(rooms.map(r => r.server));
  const showServer = servers.size > 1;

  return (
    <View style={styles.container}>
      <Pressable style={styles.header} onPress={() => onNavigate({name: 'home'})}>
        <Text style={styles.title}>Rooms</Text>
      </Pressable>

      <FlatList
        style={styles.list}
        data={rooms}
        keyExtractor={r => r.key}
        renderItem={({item}) => (
          <Pressable
            style={[styles.row, {borderLeftColor: item.color}, item.key === activeKey && styles.rowActive]}
            onPress={() => onNavigate({name: 'room', key: item.key})}>
            <View style={styles.rowTitleRow}>
              <Text style={[styles.rowTitle, item.unread && styles.rowTitleUnread]} numberOfLines={1}>
                {item.name}
              </Text>
              {item.unread && <View style={[styles.rowDot, {backgroundColor: theme.primary}]} />}
            </View>
            <Text style={styles.rowSubtitle} numberOfLines={1}>
              {showServer ? item.server.replace(/^https?:\/\//, '') + ' · ' : ''}
              {item.lastAt ? timeAgo(item.lastAt) : 'quiet'}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.loadingSpinner} color={theme.text} />
          ) : (
            <Text style={styles.empty}>No rooms yet. Start one, or open an invite link.</Text>
          )
        }
      />

      <Pressable style={styles.joinButton} onPress={() => onNavigate({name: 'join'})}>
        <Text style={styles.joinButtonText}>Join via link</Text>
      </Pressable>

      <Pressable style={styles.addButton} onPress={() => onNavigate({name: 'newRoom'})}>
        <Text style={styles.addButtonText}>+ New Room</Text>
      </Pressable>

      <Pressable style={styles.settingsButton} onPress={() => onNavigate({name: 'settings'})}>
        <Icon name="gear" size={16} color={theme.text} />
        <Text style={styles.settingsText}>Settings</Text>
      </Pressable>
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
    container: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    header: {
      paddingHorizontal: 16,
      paddingTop: 20,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    title: {
      fontSize: 18,
      fontWeight: '700',
      color: theme.text,
    },
    list: {
      flex: 1,
    },
    row: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      // Room color accent, the same treatment super-badger gives stations.
      borderLeftWidth: 4,
    },
    rowActive: {
      backgroundColor: theme.surface,
    },
    rowTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    rowTitle: {
      flexShrink: 1,
      fontSize: 15,
      fontWeight: '600',
      color: theme.text,
    },
    rowTitleUnread: {
      fontWeight: '800',
    },
    rowDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
    },
    rowSubtitle: {
      fontSize: 12,
      color: theme.textMuted,
      marginTop: 2,
    },
    empty: {
      padding: 16,
      color: theme.textMuted,
    },
    loadingSpinner: {
      padding: 24,
    },
    joinButton: {
      marginTop: 12,
      marginHorizontal: 12,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: theme.surfaceAlt,
      alignItems: 'center',
    },
    joinButtonText: {
      color: theme.text,
      fontWeight: '600',
    },
    addButton: {
      margin: 12,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: theme.primary,
      alignItems: 'center',
    },
    addButtonText: {
      color: theme.primaryText,
      fontWeight: '600',
    },
    settingsButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    settingsText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.text,
    },
  });
}
