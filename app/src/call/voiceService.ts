// Android: while in a voice room, the app's foreground-service notification
// (the same one BackgroundMonitorService uses for background messages)
// switches to "In voice · <room>" with Mute, Sound off and Leave, and gains
// the microphone service type so Android keeps the mic and audio going with
// the app in the background. Android 14 only allows that type to start
// while the app is in the foreground, which joining always is.
import {PermissionsAndroid, Platform} from 'react-native';

import {voiceSummary, type VoiceView} from './engine';

export const VOICE_ACTIONS = {
  mute: 'voice-mute',
  deafen: 'voice-deafen',
  leave: 'voice-leave',
} as const;

let handler: ((id: string) => void) | null = null;
/** Set by the voice singleton: what the notification's buttons do. */
export function setVoiceActionHandler(h: (id: string) => void) {
  handler = h;
}

/** Routes a notification action press; true if it was a voice action. */
export function handleVoiceAction(id: string | undefined): boolean {
  if (!id || !Object.values(VOICE_ACTIONS).includes(id as any)) return false;
  handler?.(id);
  return true;
}

let shown: string | null = null;

async function show(view: VoiceView, roomName: string) {
  // Android kills the app if a microphone-type foreground service starts
  // without the mic permission; never risk it.
  if (
    !(await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ))
  ) {
    shown = null;
    return;
  }
  const [
    {default: notifee, AndroidForegroundServiceType},
    ch,
    msgs,
    {isSideload},
  ] = await Promise.all([
    import('@notifee/react-native'),
    import('../notifications/channels'),
    import('../notifications/messages'),
    import('../distribution'),
  ]);
  await ch.ensureChannels();
  const status =
    view.phase === 'live'
      ? `${voiceSummary(view.peers.length, true)}${
          view.muted ? ' · Muted' : ''
        }${view.deafened ? ' · Sound off' : ''}`
      : view.signalingDown
      ? 'Reconnecting…'
      : 'Connecting…';
  await notifee.displayNotification({
    id: ch.NID_FGS,
    title: `In voice · ${roomName || 'Super Chat'}`,
    body: status,
    data: {...ch.PREFER_SMALL_ICON, voiceRoom: view.roomKey ?? ''},
    android: {
      channelId: ch.CH_SERVICE,
      smallIcon: 'ic_notification',
      pressAction: ch.PRESS_ACTION,
      asForegroundService: true,
      color: await msgs.notificationColor(),
      // Every type asked for here must be declared on the service in the
      // flavor's manifest, or startForeground throws and the app dies. Only
      // the sideload build declares dataSync (its background connection
      // shares this notification); the Play build has microphone alone.
      foregroundServiceTypes: [
        ...(isSideload
          ? [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC]
          : []),
        AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      ],
      ongoing: true,
      onlyAlertOnce: true,
      actions: [
        {
          title: view.muted ? 'Unmute' : 'Mute',
          pressAction: {id: VOICE_ACTIONS.mute},
        },
        {
          title: view.deafened ? 'Sound on' : 'Sound off',
          pressAction: {id: VOICE_ACTIONS.deafen},
        },
        {title: 'Leave', pressAction: {id: VOICE_ACTIONS.leave}},
      ],
    },
  });
}

export const voiceService = {
  update(view: VoiceView, roomName: string) {
    if (Platform.OS !== 'android') return;
    const people = view.peers.length + 1;
    const key = [
      view.phase === 'live',
      view.signalingDown,
      view.muted,
      view.deafened,
      people,
      roomName,
    ].join('|');
    if (key === shown) return;
    shown = key;
    show(view, roomName).catch(err =>
      console.warn('[superchat] voice notification failed', err),
    );
  },
  stop() {
    if (Platform.OS !== 'android' || shown === null) return;
    shown = null;
    (async () => {
      const {settingsStore} = await import('../settings');
      const {isSideload} = await import('../distribution');
      if (isSideload && settingsStore.get().bgNotifications) {
        // Back to the plain background-messages notification.
        const {startMonitoring} = await import(
          '../service/BackgroundMonitorService'
        );
        await startMonitoring();
      } else {
        const {default: notifee} = await import('@notifee/react-native');
        await notifee.stopForegroundService();
      }
    })().catch(err =>
      console.warn('[superchat] voice notification stop failed', err),
    );
  },
};
