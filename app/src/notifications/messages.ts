// New-message notifications, styled the way super-badger styles its alerts:
// the small bubble icon tinted with the room's color, one notification per
// room that the newest message replaces. Messages are decrypted on the
// phone before this ever sees them; nothing goes through a push service.
import notifee from '@notifee/react-native';

import {fingerprint} from '../crypto';
import {rgbToHex, themeAccent} from '../logo/logoTheme';
import {settingsStore} from '../settings';
import type {ChatMessage, Room} from '../store';
import {THEMES} from '../theme';
import {CH_MESSAGES, ensureChannels, PREFER_SMALL_ICON, PRESS_ACTION} from './channels';

// The tint for the status-bar icon and the notification's accent: the room's
// color when it has one, else the app theme's accent (the same color the
// themed launcher icon is drawn in).
export async function notificationColor(roomColor?: string | null): Promise<string> {
  if (roomColor) return roomColor;
  const {themeName} = await settingsStore.load();
  return rgbToHex(themeAccent(THEMES[themeName] ?? THEMES.dark));
}

const nid = (roomKey: string) => `room-${roomKey.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 64);

// The room on screen with the app in the foreground, or null (set by
// App.tsx). Its notification is cleared when opened, and new messages for it
// don't notify.
let viewingRoom: string | null = null;

export async function setViewingRoom(roomKey: string | null): Promise<void> {
  viewingRoom = roomKey;
  if (roomKey) await notifee.cancelNotification(nid(roomKey)).catch(() => {});
}

const unread = new Map<string, number>();

export async function notifyMessage(room: Room, msg: ChatMessage): Promise<void> {
  const s = settingsStore.get();
  if (!s.bgNotifications || room.key === viewingRoom) return;
  await ensureChannels();
  const count = (unread.get(room.key) ?? 0) + 1;
  unread.set(room.key, count);
  const roomName = room.view?.name ?? 'Super Chat';
  const sender = room.view?.names[msg.sender] ?? fingerprint(msg.sender);
  let body = count > 1 ? `${count} new messages` : 'New message';
  if (s.notifPreviews && msg.content) {
    const c = msg.content;
    const text = c.t === 'text' ? c.body : c.t === 'file' ? c.body || '📎 Attachment' : '';
    if (text) body = `${sender}: ${text.slice(0, 300)}`;
  }
  await notifee.displayNotification({
    id: nid(room.key),
    title: roomName,
    body,
    data: {roomKey: room.key, ...PREFER_SMALL_ICON},
    android: {
      channelId: CH_MESSAGES,
      smallIcon: 'ic_notification',
      color: await notificationColor(room.view?.color),
      pressAction: PRESS_ACTION,
      timestamp: msg.createdAt,
      showTimestamp: true,
    },
  });
}

export function clearUnread(roomKey: string) {
  unread.delete(roomKey);
}

export async function sendTestNotification(): Promise<void> {
  await notifee.requestPermission();
  await ensureChannels();
  await notifee.displayNotification({
    id: 'superchat-test',
    title: 'Super Chat',
    body: 'Notifications are working. Messages are decrypted on this phone.',
    data: PREFER_SMALL_ICON,
    android: {
      channelId: CH_MESSAGES,
      smallIcon: 'ic_notification',
      color: await notificationColor(),
      pressAction: PRESS_ACTION,
    },
  });
}
