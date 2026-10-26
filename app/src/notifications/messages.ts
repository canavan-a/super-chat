// New-message notifications, styled the way super-badger styles its alerts:
// the small icon tinted with the app theme's color, one notification per
// room that the newest message replaces. Messages are decrypted on the
// phone before this ever sees them; nothing goes through a push service.
import notifee, {AndroidStyle} from '@notifee/react-native';
import {NativeModules} from 'react-native';

import {fingerprint} from '../crypto';
import {isSideload} from '../distribution';
import {rgbToHex, themeAccent} from '../logo/logoTheme';
import {settingsStore} from '../settings';
import type {ChatMessage, Room} from '../store';
import {THEMES} from '../theme';
import {CH_MESSAGES, ensureChannels, PREFER_SMALL_ICON, PRESS_ACTION} from './channels';

// The tint for the status-bar icon and the notification's accent: always the
// app theme's accent (the color the themed launcher icon is drawn in), never
// a room's color, so every Super Chat notification looks the same.
export async function notificationColor(): Promise<string> {
  const {themeName} = await settingsStore.load();
  return rgbToHex(themeAccent(THEMES[themeName] ?? THEMES.dark));
}

/**
 * The sideloaded build notifies when "Notify on new messages" is on (it
 * starts the background service). The Google Play build has no such switch:
 * it notifies while the app is running.
 */
const notificationsOn = (bgSetting: boolean) => (isSideload ? bgSetting : true);

const nid = (roomKey: string) => `room-${roomKey.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 64);

// The room on screen with the app in the foreground, or null (set by
// App.tsx). Its notification is cleared when opened, and new messages for it
// don't notify.
let viewingRoom: string | null = null;

export async function setViewingRoom(roomKey: string | null): Promise<void> {
  viewingRoom = roomKey;
  if (roomKey) await notifee.cancelNotification(nid(roomKey)).catch(() => {});
}

/** A room's messages since it was last opened, for its notification. */
interface Line {
  sender: string;
  text: string;
  at: number;
}
const unread = new Map<string, Line[]>();
/** The most a room's expanded notification lists (the newest ones). */
const MAX_LINES = 25;

export async function notifyMessage(room: Room, msg: ChatMessage): Promise<void> {
  const s = settingsStore.get();
  if (!notificationsOn(s.bgNotifications) || room.key === viewingRoom) return;
  await ensureChannels();
  const c = msg.content;
  const line: Line = {
    sender: room.view?.names[msg.sender] ?? fingerprint(msg.sender),
    text: (
      c?.t === 'text' ? c.body : c?.t === 'file' ? c.body || '📎 Attachment' : c?.t === 'ice' ? '🔊 Shared a voice server' : '🔒 Message'
    ).slice(0, 300),
    at: msg.createdAt,
  };
  // The real one replaces the plain "New message" a wake-up may have shown
  // for it (src/push.ts), so the two don't both sit there.
  NativeModules.Push?.clearLocked?.();
  const lines = [...(unread.get(room.key) ?? []), line].slice(-MAX_LINES);
  unread.set(room.key, lines);
  const roomName = room.view?.name ?? 'Super Chat';
  const shared = {
    id: nid(room.key),
    title: roomName,
    data: {roomKey: room.key, ...PREFER_SMALL_ICON},
  };
  const android = {
    channelId: CH_MESSAGES,
    smallIcon: 'ic_notification',
    color: await notificationColor(),
    pressAction: PRESS_ACTION,
    timestamp: msg.createdAt,
    showTimestamp: true,
  };
  if (!s.notifPreviews) {
    await notifee.displayNotification({
      ...shared,
      body: lines.length > 1 ? `${lines.length} new messages` : 'New message',
      android,
    });
    return;
  }
  // Messaging style: collapsed it shows the newest message; pulled down it
  // lists every new one since the room was last opened, each with its sender.
  await notifee.displayNotification({
    ...shared,
    body: `${line.sender}: ${line.text}`,
    android: {
      ...android,
      style: {
        type: AndroidStyle.MESSAGING,
        person: {name: 'You'},
        title: roomName,
        group: true,
        messages: lines.map(l => ({text: l.text, timestamp: l.at, person: {name: l.sender}})),
      },
    },
  });
}

export function clearUnread(roomKey: string) {
  unread.delete(roomKey);
}

/** The caller checks permission first (ensureNotificationPermission). */
export async function sendTestNotification(): Promise<void> {
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

/**
 * Someone opened a room's voice that was empty. Only then: joining a voice
 * room that already has people in it doesn't notify anyone.
 */
export async function notifyVoiceStart(room: Room, member: string, inThatVoice: boolean): Promise<void> {
  const s = settingsStore.get();
  if (!notificationsOn(s.bgNotifications) || room.key === viewingRoom || inThatVoice) return;
  await ensureChannels();
  const name = room.view?.names[member] ?? fingerprint(member);
  const roomName = room.view?.name ?? 'Super Chat';
  await notifee.displayNotification({
    id: `voice-${nid(room.key)}`.slice(0, 64),
    title: roomName,
    body: s.notifPreviews ? `🔊 ${name} is in voice` : '🔊 Someone is in voice',
    data: {roomKey: room.key, ...PREFER_SMALL_ICON},
    android: {
      channelId: CH_MESSAGES,
      smallIcon: 'ic_notification',
      color: await notificationColor(),
      pressAction: PRESS_ACTION,
      timestamp: Date.now(),
      showTimestamp: true,
    },
  });
}
