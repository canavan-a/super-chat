// The voice buttons, shared by the global bar (VoiceBar) and the voice
// screen, so mute, sound off and the speaker always show the same state
// everywhere (they all read the one engine).
import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {useVoice, voice} from '../call/voice';
import {rtcPlatform} from '../rtc';
import {Theme, useTheme} from '../theme';
import {Icon, IconName} from './Icon';
import {Overlay} from './Overlay';

function Btn({
  icon,
  label,
  onPress,
  color,
  bg,
  size,
  disabled,
  showLabel,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color: string;
  bg?: string;
  size: number;
  disabled?: boolean;
  showLabel?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({pressed}) => [
        styles.btn,
        {
          minWidth: Math.max(44, size),
          height: Math.max(44, size),
          borderRadius: Math.max(44, size) / 2,
        },
        bg ? {backgroundColor: bg} : null,
        (pressed || disabled) && {opacity: 0.55},
      ]}>
      <Icon name={icon} size={size * 0.45} color={color} />
      {showLabel ? (
        <Text style={[styles.btnLabel, {color: theme.textMuted}]}>
          {showLabel}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** compact: the bar (small, no labels); otherwise the voice screen's controls. */
export function VoiceControls({
  compact,
  showSpeaker = true,
}: {
  compact?: boolean;
  showSpeaker?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const v = useVoice();
  const [picker, setPicker] = useState<{id: string; label: string}[] | null>(
    null,
  );
  const size = compact ? 36 : 56;
  const fg = theme.text;
  const bg = compact ? undefined : theme.surfaceAlt;
  const label = (s: string) => (compact ? undefined : s);

  const speaker = (() => {
    if (!showSpeaker) return null;
    if (rtcPlatform.hasSpeakerToggle) {
      const headset = v.route === 'headset';
      return (
        <Btn
          icon={headset ? 'headphones' : 'speaker'}
          label={
            headset
              ? 'Headset'
              : v.speakerOn
              ? 'Switch to earpiece'
              : 'Switch to speaker'
          }
          onPress={() => voice.setSpeakerOn(!v.speakerOn)}
          color={v.speakerOn && !headset ? theme.primary : fg}
          bg={bg}
          size={size}
          disabled={headset}
          showLabel={label(
            headset ? 'Headset' : v.speakerOn ? 'Speaker' : 'Earpiece',
          )}
        />
      );
    }
    if (rtcPlatform.hasOutputPicker) {
      return (
        <Btn
          icon="speaker"
          label="Choose audio output"
          onPress={async () => {
            const picked = await rtcPlatform.pickOutput();
            if (picked) voice.setOutputDevice(picked);
            else setPicker(await rtcPlatform.listOutputs());
          }}
          color={fg}
          bg={bg}
          size={size}
          showLabel={label('Output')}
        />
      );
    }
    return null;
  })();

  return (
    <View style={[styles.row, {gap: compact ? 2 : 18}]}>
      <Btn
        icon={v.muted ? 'mic-off' : 'mic'}
        label={v.muted ? 'Unmute' : 'Mute'}
        onPress={() => voice.setMuted(!v.muted)}
        color={v.muted ? theme.danger : fg}
        bg={v.muted && !compact ? theme.dangerBg : bg}
        size={size}
        showLabel={label(v.muted ? 'Muted' : 'Mute')}
      />
      <Btn
        icon={v.deafened ? 'volume-x' : 'volume-2'}
        label={v.deafened ? 'Turn sound on' : 'Turn sound off'}
        onPress={() => voice.setDeafened(!v.deafened)}
        color={v.deafened ? theme.danger : fg}
        bg={v.deafened && !compact ? theme.dangerBg : bg}
        size={size}
        showLabel={label(v.deafened ? 'Sound off' : 'Sound')}
      />
      {speaker}
      <Btn
        icon="phone-off"
        label="Leave voice"
        onPress={() => voice.leave().catch(() => {})}
        color={compact ? theme.danger : '#fff'}
        bg={compact ? undefined : theme.danger}
        size={size}
        showLabel={label('Leave')}
      />
      {picker ? (
        <OutputPicker
          devices={picker}
          theme={theme}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </View>
  );
}

function OutputPicker({
  devices,
  theme,
  onClose,
}: {
  devices: {id: string; label: string}[];
  theme: Theme;
  onClose: () => void;
}) {
  const v = useVoice();
  return (
    <Overlay visible onClose={onClose} style={styles.center}>
      <View
        style={[
          styles.sheet,
          {backgroundColor: theme.surface, borderColor: theme.border},
        ]}>
        <Text style={[styles.sheetTitle, {color: theme.text}]}>
          Play voice through
        </Text>
        {devices.length === 0 ? (
          <Text style={{color: theme.textMuted}}>No outputs found.</Text>
        ) : null}
        {devices.map(d => (
          <Pressable
            key={d.id}
            style={styles.sheetRow}
            onPress={() => {
              voice.setOutputDevice(d.id);
              onClose();
            }}>
            <Text style={{color: theme.text, flex: 1}} numberOfLines={1}>
              {d.label}
            </Text>
            {(v.outputDevice ?? 'default') === d.id ? (
              <Icon name="check" size={16} color={theme.primary} />
            ) : null}
          </Pressable>
        ))}
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center'},
  btn: {alignItems: 'center', justifyContent: 'center'},
  btnLabel: {
    position: 'absolute',
    bottom: -18,
    fontSize: 11,
    width: 80,
    textAlign: 'center',
  },
  center: {justifyContent: 'center', alignItems: 'center', padding: 24},
  sheet: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    gap: 4,
  },
  sheetTitle: {fontSize: 15, fontWeight: '700', marginBottom: 8},
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 8,
  },
});
