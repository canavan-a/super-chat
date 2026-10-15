// A room's voice room: a grid of cards, one per person, each with their
// profile picture, a ring that lights up while they talk, and badges for
// muted / sound off / a weak connection. Joining, reconnecting and
// connection problems all show here (call/engine.ts holds the state).
import React, {useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  LayoutChangeEvent,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {HeaderInfo} from '../App';
import {openVoice} from '../call/actions';
import type {Diagnosis} from '../call/diagnose';
import type {PeerView, VoiceView} from '../call/engine';
import {MAX_PEERS} from '../call/engine';
import {roomVoice, useVoice, voice} from '../call/voice';
import {Avatar} from '../components/Avatar';
import {Icon, IconName} from '../components/Icon';
import {Overlay} from '../components/Overlay';
import {AMBER} from '../components/VoiceBar';
import {VoiceControls} from '../components/VoiceControls';
import {fingerprint} from '../crypto';
import type {Route} from '../routes';
import {getRoom, useStore} from '../store';
import {Theme, useTheme} from '../theme';

const CAP = MAX_PEERS + 1;

interface TileData {
  key: string;
  member: string;
  name: string;
  you: boolean;
  muted: boolean;
  deaf: boolean;
  level: number;
  state: PeerView['state'] | 'you';
  diagnosis: Diagnosis | null;
}

export function VoiceScreen({
  roomKey,
  onNavigate,
  onHeaderChange,
}: {
  roomKey: string;
  onNavigate: (r: Route) => void;
  onHeaderChange: (h: HeaderInfo | null) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const v = useVoice();
  const room = useStore(() => getRoom(roomKey));
  const presence = useStore(() => roomVoice(roomKey));
  const names = room?.view?.names ?? {};
  const nameOf = (m: string) => names[m] || fingerprint(m);
  const mine = v.roomKey === roomKey;
  const [sheet, setSheet] = useState<TileData | null>(null);

  useEffect(() => {
    onHeaderChange({
      title: room?.view?.name ?? 'Voice',
      accentColor: room?.view?.color ?? undefined,
      subtitle: `Voice · ${presence.count}/${CAP}`,
    });
  }, [room?.view?.name, room?.view?.color, presence.count, onHeaderChange]);

  const tiles: TileData[] = useMemo(() => {
    if (!mine || !room) {
      return presence.others.map(p => ({
        key: `${p.member}:${p.sid}`,
        member: p.member,
        name: nameOf(p.member),
        you: false,
        muted: p.muted,
        deaf: p.deaf,
        level: 0,
        state: 'live' as const,
        diagnosis: null,
      }));
    }
    const me: TileData = {
      key: 'me',
      member: room.me.id,
      name: 'You',
      you: true,
      muted: v.muted,
      deaf: v.deafened,
      level: v.localLevel,
      state: 'you',
      diagnosis: null,
    };
    // Anyone the room knows is in voice but we haven't heard from yet still
    // gets a (connecting) card, so the grid fills in at once.
    const known = new Set(v.peers.map(p => p.id));
    const pending =
      v.phase === 'connecting' || v.phase === 'finding'
        ? presence.others.filter(p => !known.has(`${p.member}:${p.sid}`))
        : [];
    return [
      me,
      ...v.peers.map(p => ({
        key: p.id,
        member: p.member,
        name: nameOf(p.member),
        you: false,
        muted: p.muted,
        deaf: p.deaf,
        level: p.level,
        state: p.state,
        diagnosis: p.diagnosis,
      })),
      ...pending.map(p => ({
        key: `${p.member}:${p.sid}`,
        member: p.member,
        name: nameOf(p.member),
        you: false,
        muted: p.muted,
        deaf: p.deaf,
        level: 0,
        state: 'connecting' as const,
        diagnosis: null,
      })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, room, v, presence, names]);

  // ---- not in this voice room (or the join ended with an error) ----

  if (!mine) {
    return (
      <View style={styles.container}>
        {v.error && !v.roomKey ? (
          <ErrorPanel
            v={v}
            theme={theme}
            roomKey={roomKey}
            onNavigate={onNavigate}
          />
        ) : null}
        {!v.error || v.roomKey ? (
          <>
            {tiles.length ? (
              <Grid
                tiles={tiles}
                roomKey={roomKey}
                theme={theme}
                onInfo={setSheet}
              />
            ) : (
              <View style={styles.flex} />
            )}
            <View style={styles.center}>
              <Text style={styles.muted}>
                {tiles.length
                  ? `${tiles.length} in voice`
                  : 'Nobody is in voice yet.'}
              </Text>
              <Pressable
                style={[styles.primaryBtn, presence.full && styles.disabled]}
                disabled={presence.full}
                onPress={() => openVoice(roomKey, onNavigate)}>
                <Icon name="headphones" size={18} color={theme.primaryText} />
                <Text style={styles.primaryBtnText}>
                  {presence.full ? `Full (${CAP}/${CAP})` : 'Join voice'}
                </Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </View>
    );
  }

  // ---- joining ----

  const joining =
    v.phase === 'config' ||
    v.phase === 'mic' ||
    v.phase === 'finding' ||
    v.phase === 'confirm-no-servers';
  if (joining) {
    const label =
      v.phase === 'mic'
        ? 'Allow microphone…'
        : v.phase === 'finding'
        ? 'Joining voice…'
        : 'Preparing…';
    return (
      <View style={styles.container}>
        <View style={styles.joining}>
          <Pulse theme={theme}>
            <Avatar roomKey={roomKey} member={room!.me.id} size={112} />
          </Pulse>
          <ActivityIndicator color={theme.textMuted} style={{marginTop: 24}} />
          <Text style={styles.joiningText}>{label}</Text>
        </View>
        <NoServersDialog
          visible={v.phase === 'confirm-no-servers'}
          theme={theme}
          onNavigate={onNavigate}
        />
      </View>
    );
  }

  const noticeVisible = v.notice && Date.now() - v.notice.at < 3500;

  return (
    <View style={styles.container}>
      {v.signalingDown ? (
        <Banner
          theme={theme}
          color={AMBER}
          icon="retry"
          text="Reconnecting to server…"
        />
      ) : null}
      {!v.signalingDown && v.unstable ? (
        <Banner
          theme={theme}
          color={AMBER}
          icon="signal-low"
          text="Your connection is unstable"
        />
      ) : null}
      {v.coverage === 'stun-only' && !v.stunWarningDismissed ? (
        <Banner
          theme={theme}
          color={AMBER}
          icon="warning"
          text="No TURN relay configured. You may not be able to connect to some people, especially on mobile data or strict networks."
          action={{
            label: 'Voice settings',
            onPress: () => onNavigate({name: 'settings'}),
          }}
          onClose={() => voice.dismissStunWarning()}
        />
      ) : null}
      {v.coverage === 'none' ? (
        <Banner
          theme={theme}
          color={AMBER}
          icon="warning"
          text="No STUN/TURN servers: voice only connects to people on your network."
          action={{
            label: 'Voice settings',
            onPress: () => onNavigate({name: 'settings'}),
          }}
        />
      ) : null}
      {v.audioBlocked ? (
        <Banner
          theme={theme}
          color={theme.primary}
          icon="volume-x"
          text="Your browser paused audio. Tap anywhere to enable it."
        />
      ) : null}

      {v.peers.length === 0 && v.phase === 'live' ? (
        <Text style={[styles.muted, styles.alone]}>
          You're the only one here.
        </Text>
      ) : null}
      <Grid tiles={tiles} roomKey={roomKey} theme={theme} onInfo={setSheet} />

      {noticeVisible ? (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{v.notice!.text}</Text>
        </View>
      ) : null}

      <View style={styles.controls}>
        <VoiceControls />
      </View>

      {v.error?.kind === 'timeout' ? (
        <Overlay
          visible
          onClose={() => voice.clearError()}
          style={styles.dialogLayer}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>{v.error.message}</Text>
            {v.error.diagnosis ? (
              <Text style={styles.dialogBody}>{v.error.diagnosis.message}</Text>
            ) : null}
            <View style={styles.dialogButtons}>
              {v.error.diagnosis?.fixInSettings ? (
                <DialogBtn
                  theme={theme}
                  label="Voice settings"
                  onPress={() => onNavigate({name: 'settings'})}
                />
              ) : null}
              <DialogBtn
                theme={theme}
                label="Leave"
                onPress={() => voice.leave()}
              />
              <DialogBtn
                theme={theme}
                label="Retry"
                primary
                onPress={() => voice.retry()}
              />
            </View>
          </View>
        </Overlay>
      ) : null}

      <Overlay
        visible={!!sheet}
        onClose={() => setSheet(null)}
        style={styles.dialogLayer}>
        {sheet ? (
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>
              Can't connect to {sheet.name}
            </Text>
            <Text style={styles.dialogBody}>
              {sheet.diagnosis?.message ?? 'The connection failed.'}
            </Text>
            <View style={styles.dialogButtons}>
              <DialogBtn
                theme={theme}
                label="Voice settings"
                onPress={() => {
                  setSheet(null);
                  onNavigate({name: 'settings'});
                }}
              />
              <DialogBtn
                theme={theme}
                label="Retry"
                primary
                onPress={() => {
                  setSheet(null);
                  voice.retry();
                }}
              />
            </View>
          </View>
        ) : null}
      </Overlay>
    </View>
  );
}

// ---- the grid ----

function Grid({
  tiles,
  roomKey,
  theme,
  onInfo,
}: {
  tiles: TileData[];
  roomKey: string;
  theme: Theme;
  onInfo: (t: TileData) => void;
}) {
  const [box, setBox] = useState({w: 0, h: 0});
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const n = Math.max(1, tiles.length);
  const wide = box.w >= 700;
  const cols = wide ? Math.ceil(Math.sqrt(n)) : n === 1 ? 1 : 2;
  const rows = Math.ceil(n / cols);
  const gap = 12;
  const size = Math.max(
    80,
    Math.floor(
      Math.min(
        (box.w - gap * (cols + 1)) / cols,
        rows > 0 ? (box.h - gap * (rows + 1)) / rows : Infinity,
        260,
      ),
    ),
  );
  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.gridContent}
      onLayout={(e: LayoutChangeEvent) =>
        setBox({w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height})
      }>
      {box.w > 0 ? (
        <View
          style={[styles.grid, {gap, width: cols * size + (cols - 1) * gap}]}>
          {tiles.map(t => (
            <Tile
              key={t.key}
              t={t}
              size={size}
              roomKey={roomKey}
              theme={theme}
              onInfo={onInfo}
            />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const STATE_TEXT: Partial<Record<TileData['state'], string>> = {
  connecting: 'Connecting…',
  stalled: 'Buffering…',
  reconnecting: 'Reconnecting…',
  failed: "Can't connect",
};

function Tile({
  t,
  size,
  roomKey,
  theme,
  onInfo,
}: {
  t: TileData;
  size: number;
  roomKey: string;
  theme: Theme;
  onInfo: (t: TileData) => void;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const dim =
    t.state === 'connecting' ||
    t.state === 'stalled' ||
    t.state === 'reconnecting' ||
    t.state === 'failed';
  const speaking = !dim && !t.muted && t.level > 0.04;
  const avatar = Math.round(size * 0.5);
  const overlay = STATE_TEXT[t.state];
  return (
    <Pressable
      disabled={t.state !== 'failed'}
      onPress={() => onInfo(t)}
      accessibilityLabel={`${t.name}${t.muted ? ', muted' : ''}${
        t.deaf ? ', sound off' : ''
      }${overlay ? `, ${overlay}` : ''}`}
      style={[
        styles.tile,
        {width: size, height: size},
        speaking && {borderColor: theme.primary, borderWidth: 3},
        t.state === 'failed' && {borderColor: theme.danger},
      ]}>
      <View style={{opacity: dim ? 0.4 : 1}}>
        <Avatar
          roomKey={roomKey}
          member={t.member}
          name={t.you ? null : t.name}
          size={avatar}
        />
      </View>
      {overlay ? (
        <View style={styles.tileOverlay}>
          {t.state === 'failed' ? (
            <Icon name="info" size={18} color={theme.danger} />
          ) : (
            <ActivityIndicator size="small" color={theme.text} />
          )}
          <Text
            style={[
              styles.tileOverlayText,
              t.state === 'failed' && {color: theme.danger},
            ]}>
            {overlay}
          </Text>
        </View>
      ) : null}
      <View style={styles.tileFooter}>
        <Text style={styles.tileName} numberOfLines={1}>
          {t.name}
        </Text>
        {t.muted ? <Badge icon="mic-off" color={theme.danger} /> : null}
        {t.deaf ? <Badge icon="headphone-off" color={theme.danger} /> : null}
        {t.state === 'weak' ? <Badge icon="signal-low" color={AMBER} /> : null}
      </View>
    </Pressable>
  );
}

function Badge({icon, color}: {icon: IconName; color: string}) {
  return <Icon name={icon} size={14} color={color} />;
}

// ---- bits ----

function Pulse({theme, children}: {theme: Theme; children: React.ReactNode}) {
  const [a] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, {toValue: 1, duration: 900, useNativeDriver: true}),
        Animated.timing(a, {toValue: 0, duration: 900, useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  const scale = a.interpolate({inputRange: [0, 1], outputRange: [1, 1.06]});
  const opacity = a.interpolate({inputRange: [0, 1], outputRange: [0.75, 1]});
  return (
    <Animated.View
      style={{
        transform: [{scale}],
        opacity,
        borderRadius: 999,
        borderWidth: 3,
        borderColor: theme.primary,
        padding: 4,
      }}>
      {children}
    </Animated.View>
  );
}

function Banner({
  theme,
  color,
  icon,
  text,
  action,
  onClose,
}: {
  theme: Theme;
  color: string;
  icon: IconName;
  text: string;
  action?: {label: string; onPress: () => void};
  onClose?: () => void;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={[styles.banner, {borderLeftColor: color}]}>
      <Icon name={icon} size={16} color={color} />
      <View style={styles.flex}>
        <Text style={styles.bannerText}>{text}</Text>
        {action ? (
          <Pressable onPress={action.onPress} hitSlop={6}>
            <Text style={[styles.bannerAction, {color}]}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Dismiss">
          <Icon name="close" size={16} color={theme.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

function DialogBtn({
  theme,
  label,
  onPress,
  primary,
}: {
  theme: Theme;
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Pressable
      style={[styles.dialogBtn, primary && {backgroundColor: theme.primary}]}
      onPress={onPress}>
      <Text
        style={[styles.dialogBtnText, primary && {color: theme.primaryText}]}>
        {label}
      </Text>
    </Pressable>
  );
}

function NoServersDialog({
  visible,
  theme,
  onNavigate,
}: {
  visible: boolean;
  theme: Theme;
  onNavigate: (r: Route) => void;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Overlay
      visible={visible}
      onClose={() => voice.leave()}
      style={styles.dialogLayer}>
      <View style={styles.dialog}>
        <Text style={styles.dialogTitle}>No STUN/TURN servers configured</Text>
        <Text style={styles.dialogBody}>
          Voice will only connect to people on the same network as you. Add a
          STUN or TURN server in Settings → Voice to reach anyone else.
        </Text>
        <View style={styles.dialogButtons}>
          <DialogBtn
            theme={theme}
            label="Cancel"
            onPress={() => voice.leave()}
          />
          <DialogBtn
            theme={theme}
            label="Voice settings"
            onPress={() => {
              voice.leave();
              onNavigate({name: 'settings'});
            }}
          />
          <DialogBtn
            theme={theme}
            label="Join anyway"
            primary
            onPress={() => voice.confirmNoServers()}
          />
        </View>
      </View>
    </Overlay>
  );
}

function ErrorPanel({
  v,
  theme,
  roomKey,
  onNavigate,
}: {
  v: VoiceView;
  theme: Theme;
  roomKey: string;
  onNavigate: (r: Route) => void;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const e = v.error!;
  const hint =
    e.kind === 'mic-denied'
      ? 'Allow microphone access for Super Chat in your device or browser settings, then try again.'
      : e.kind === 'full'
      ? 'Someone has to leave before you can join.'
      : null;
  return (
    <View style={styles.errorPanel}>
      <Icon
        name={e.kind === 'mic-denied' ? 'mic-off' : 'warning'}
        size={36}
        color={theme.danger}
      />
      <Text style={styles.dialogTitle}>{e.message}</Text>
      {hint ? (
        <Text style={[styles.dialogBody, {textAlign: 'center'}]}>{hint}</Text>
      ) : null}
      <View style={styles.dialogButtons}>
        {e.kind === 'mic-denied' ? <OpenSettingsButton theme={theme} /> : null}
        <DialogBtn
          theme={theme}
          label="Close"
          onPress={() => {
            voice.clearError();
            onNavigate({name: 'room', key: roomKey});
          }}
        />
        {e.kind !== 'unsupported' ? (
          <DialogBtn
            theme={theme}
            label="Try again"
            primary
            onPress={() => {
              voice.clearError();
              openVoice(roomKey, onNavigate);
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

function OpenSettingsButton({theme}: {theme: Theme}) {
  if (Platform.OS !== 'android') return null;
  return (
    <DialogBtn
      theme={theme}
      label="App settings"
      onPress={() => Linking.openSettings().catch(() => {})}
    />
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    flex: {flex: 1},
    center: {alignItems: 'center', gap: 12, paddingVertical: 24},
    muted: {color: theme.textMuted, fontSize: 13, textAlign: 'center'},
    alone: {marginTop: 12},
    primaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: theme.primary,
      paddingHorizontal: 22,
      paddingVertical: 12,
      borderRadius: 24,
    },
    primaryBtnText: {color: theme.primaryText, fontWeight: '700', fontSize: 15},
    disabled: {opacity: 0.5},
    joining: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    joiningText: {marginTop: 10, color: theme.textMuted, fontSize: 14},
    gridContent: {
      flexGrow: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 12,
    },
    grid: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center'},
    tile: {
      borderRadius: 16,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    tileOverlay: {position: 'absolute', alignItems: 'center', gap: 6},
    tileOverlayText: {color: theme.text, fontSize: 12, fontWeight: '600'},
    tileFooter: {
      position: 'absolute',
      left: 8,
      right: 8,
      bottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    tileName: {flex: 1, color: theme.text, fontSize: 12, fontWeight: '600'},
    controls: {
      paddingTop: 16,
      paddingBottom: 34,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      backgroundColor: theme.surface,
    },
    banner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: theme.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      borderLeftWidth: 4,
    },
    bannerText: {color: theme.text, fontSize: 12, lineHeight: 17},
    bannerAction: {fontSize: 12, fontWeight: '700', marginTop: 4},
    toast: {
      position: 'absolute',
      alignSelf: 'center',
      bottom: 140,
      backgroundColor: theme.surfaceAlt,
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: theme.border,
    },
    toastText: {color: theme.text, fontSize: 13},
    dialogLayer: {justifyContent: 'center', alignItems: 'center', padding: 24},
    dialog: {
      width: '100%',
      maxWidth: 400,
      backgroundColor: theme.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.border,
      padding: 18,
      gap: 10,
    },
    dialogTitle: {
      color: theme.text,
      fontSize: 16,
      fontWeight: '700',
      textAlign: 'center',
    },
    dialogBody: {color: theme.textMuted, fontSize: 13, lineHeight: 19},
    dialogButtons: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 6,
    },
    dialogBtn: {
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderRadius: 8,
      backgroundColor: theme.surfaceAlt,
    },
    dialogBtnText: {color: theme.text, fontWeight: '600', fontSize: 13},
    errorPanel: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      gap: 12,
    },
  });
}
