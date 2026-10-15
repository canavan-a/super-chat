// The global "you're in voice" bar: under the top bar on every screen but the
// voice screen itself, until you leave. It never blocks navigation; tapping
// it goes back to the voice screen. Mute, sound off, the speaker and leave
// work from here too.
import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import {useVoice} from '../call/voice';
import type {Route} from '../routes';
import {getRoom, useStore} from '../store';
import {Theme, useTheme} from '../theme';
import {Icon} from './Icon';
import {VoiceControls} from './VoiceControls';

export const AMBER = '#D9940F';

function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function VoiceBar({
  navigate,
}: {
  navigate: (r: Route) => void;
}): React.JSX.Element | null {
  const theme = useTheme();
  const v = useVoice();
  const {width} = useWindowDimensions();
  const roomName = useStore(() =>
    v.roomKey ? getRoom(v.roomKey)?.view?.name ?? 'Voice' : '',
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (v.phase !== 'live') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [v.phase]);
  if (!v.roomKey || v.phase === 'idle') return null;

  const joining = v.phase !== 'live' && v.phase !== 'leaving';
  const status = v.error
    ? {color: theme.danger, text: v.error.message}
    : v.phase === 'leaving'
    ? {color: theme.textMuted, text: 'Leaving…'}
    : v.signalingDown
    ? {color: AMBER, text: 'Reconnecting…'}
    : v.unstable
    ? {color: AMBER, text: 'Connection unstable'}
    : joining
    ? {color: AMBER, text: 'Connecting…'}
    : {color: theme.success, text: null};
  const people = v.peers.length + 1;
  const narrow = width < 340;
  const styles = makeStyles(theme, status.color);

  return (
    <View style={styles.bar}>
      <Pressable
        style={styles.info}
        onPress={() => navigate({name: 'voice', key: v.roomKey!})}
        accessibilityRole="button"
        accessibilityLabel={`In voice in ${roomName}. Open voice room`}>
        {joining && !v.error ? (
          <ActivityIndicator size="small" color={status.color} />
        ) : (
          <Icon name="volume-2" size={16} color={status.color} />
        )}
        <View style={styles.texts}>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>
              {roomName}
            </Text>
            {v.coverage === 'stun-only' ? (
              <Icon name="warning" size={13} color={AMBER} />
            ) : null}
          </View>
          <Text
            style={[styles.sub, status.text ? {color: status.color} : null]}
            numberOfLines={1}>
            {status.text ??
              `${people} in voice${
                !narrow && v.startedAt ? ` · ${elapsed(v.startedAt, now)}` : ''
              }${v.muted ? ' · Muted' : ''}`}
            {v.audioBlocked ? ' · Tap to enable audio' : ''}
          </Text>
        </View>
      </Pressable>
      <VoiceControls compact showSpeaker={!narrow} />
    </View>
  );
}

function makeStyles(theme: Theme, accent: string) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: 12,
      paddingRight: 6,
      minHeight: 48,
      backgroundColor: theme.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      borderLeftWidth: 4,
      borderLeftColor: accent,
    },
    info: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 6,
    },
    texts: {flex: 1, minWidth: 0},
    titleRow: {flexDirection: 'row', alignItems: 'center', gap: 4},
    title: {fontSize: 13, fontWeight: '700', color: theme.text, flexShrink: 1},
    sub: {fontSize: 11, color: theme.textMuted, marginTop: 1},
  });
}
