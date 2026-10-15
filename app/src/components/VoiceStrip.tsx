// The strip under a room's header while anyone is in its voice room: who's
// there (avatars), and Join / Open / Full.
import React, {useEffect} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {openVoice} from '../call/actions';
import {MAX_PEERS, voiceSummary} from '../call/engine';
import {roomVoice, useVoice, voice} from '../call/voice';
import type {Route} from '../routes';
import {getRoom, useStore} from '../store';
import {useTheme} from '../theme';
import {Avatar} from './Avatar';
import {Icon} from './Icon';

export function VoiceStrip({
  roomKey,
  onNavigate,
}: {
  roomKey: string;
  onNavigate: (r: Route) => void;
}): React.JSX.Element | null {
  const theme = useTheme();
  useVoice(); // re-render when our own session changes
  const rv = useStore(() => roomVoice(roomKey));
  const me = useStore(() => getRoom(roomKey)?.me.id ?? '');
  // Voice is busy and this chat is open: get ready so Join is near instant
  // (relay credentials fetched, connections already gathering).
  const others = rv.mine ? 0 : rv.others.length;
  const full = rv.full;
  useEffect(() => {
    if (!others || full) {
      voice.cancelPrewarm();
      return;
    }
    voice.prewarm(roomKey, others).catch(() => {});
    return () => voice.cancelPrewarm();
  }, [roomKey, others, full]);
  if (rv.count === 0) return null;
  const members = [...(rv.mine ? [me] : []), ...rv.others.map(p => p.member)];
  const label = rv.mine
    ? 'Open'
    : rv.full
    ? `Full (${MAX_PEERS + 1}/${MAX_PEERS + 1})`
    : 'Join';
  return (
    <Pressable
      style={[
        styles.strip,
        {backgroundColor: theme.surface, borderBottomColor: theme.border},
      ]}
      onPress={() => openVoice(roomKey, onNavigate)}
      accessibilityRole="button"
      accessibilityLabel={`${voiceSummary(rv.others.length, rv.mine)}. ${label}`}>
      <Icon name="volume-2" size={16} color={theme.success} />
      <View style={styles.faces}>
        {members.slice(0, 5).map((m, i) => (
          <View
            key={`${m}${i}`}
            style={[
              styles.face,
              {marginLeft: i ? -8 : 0, borderColor: theme.surface},
            ]}>
            <Avatar roomKey={roomKey} member={m} size={22} />
          </View>
        ))}
      </View>
      <Text style={[styles.text, {color: theme.text}]} numberOfLines={1}>
        {voiceSummary(rv.others.length, rv.mine)}
      </Text>
      <View
        style={[
          styles.btn,
          {backgroundColor: rv.full ? theme.surfaceAlt : theme.primary},
        ]}>
        <Text
          style={[
            styles.btnText,
            {color: rv.full ? theme.textMuted : theme.primaryText},
          ]}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  faces: {flexDirection: 'row'},
  face: {borderWidth: 2, borderRadius: 13},
  text: {flex: 1, fontSize: 13, fontWeight: '600'},
  btn: {paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14},
  btnText: {fontSize: 12, fontWeight: '700'},
});
