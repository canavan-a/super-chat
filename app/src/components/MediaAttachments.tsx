// Videos and voice messages in the chat: the bubbles, the full-screen video
// player, and the bar the composer turns into while a voice message records.
// Both kinds are only downloaded and decrypted when played; the bubble draws
// from what the message itself carries (a video's poster frame, a voice
// message's waveform and length).
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, Animated, Easing, Image, Pressable, StyleSheet, Text, View} from 'react-native';

import type {FileRef} from '../crypto';
import {playableUri} from '../files';
import {fetchFile, loadImage, peekImage, ShownImage} from '../store';
import type {Theme} from '../theme';
import {barsOf, clock, WAVE_MAX} from '../voiceWave';
import {Icon} from './Icon';
import {AudioPlayer, VideoPlayer} from './MediaPlayer';
import {Overlay} from './Overlay';

// ---- decrypted files for the players ----
//
// A played video or voice message is decrypted to a temporary file
// (files.ts playableUri). Bubbles come and go as the chat scrolls, so the
// file is shared by everything showing that blob, and kept a little while
// after the last one goes: playing it again doesn't redo the work. Then it's
// deleted (and anything left is cleared next launch).

const IDLE_MS = 2 * 60_000;

interface Playable {
  ready: Promise<{uri: string; release: () => void}>;
  users: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Download progress, to everyone waiting on it. */
  listeners: Set<(fraction: number) => void>;
}
const playables = new Map<string, Playable>();

function openPlayable(roomKey: string, file: FileRef, onProgress: (fraction: number) => void): Promise<{uri: string; close: () => void}> {
  let entry = playables.get(file.blob);
  if (!entry) {
    const listeners = new Set<(fraction: number) => void>();
    const ready = fetchFile(roomKey, file, frac => listeners.forEach(l => l(frac))).then(data => playableUri(data, file.mime));
    const made: Playable = {ready, users: 0, listeners};
    entry = made;
    playables.set(file.blob, made);
    ready.catch(() => playables.get(file.blob) === made && playables.delete(file.blob));
  }
  const e = entry;
  e.users++;
  clearTimeout(e.timer);
  e.timer = undefined;
  e.listeners.add(onProgress);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    e.users--;
    e.listeners.delete(onProgress);
    if (e.users > 0) return;
    e.timer = setTimeout(() => {
      if (e.users > 0) return;
      if (playables.get(file.blob) === e) playables.delete(file.blob);
      e.ready.then(r => r.release(), () => {});
    }, IDLE_MS);
  };
  return e.ready.then(
    r => {
      e.listeners.delete(onProgress);
      return {uri: r.uri, close};
    },
    err => {
      close();
      throw err;
    },
  );
}

/** A decrypted file, ready for a player; let go of when the component goes. */
function usePlayable(roomKey: string, file: FileRef | null) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // How much has downloaded (0–1); null before any is known, or once it's here.
  const [progress, setProgress] = useState<number | null>(null);
  const release = useRef<(() => void) | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      release.current?.();
      release.current = null;
    };
  }, []);
  const load = async (): Promise<boolean> => {
    if (src) return true;
    if (!file || loading) return false;
    setLoading(true);
    setError(null);
    try {
      const p = await openPlayable(roomKey, file, frac => live.current && setProgress(frac));
      if (!live.current) {
        p.close();
        return false;
      }
      release.current = p.close;
      setSrc(p.uri);
      return true;
    } catch (e) {
      if (live.current) setError((e as Error).message || "Couldn't load it");
      return false;
    } finally {
      if (live.current) {
        setLoading(false);
        setProgress(null);
      }
    }
  };
  return {src, error, loading, progress, load};
}

// ---- video ----

export function VideoAttachment({
  roomKey,
  file,
  progress,
  theme,
  onOpen,
  onTap,
  onLongPress,
}: {
  roomKey: string;
  file: FileRef;
  /** While it's being sent: how much has uploaded (0–1). */
  progress?: number;
  theme: Theme;
  onOpen: (ref: FileRef) => void;
  onTap: (single?: () => void) => void;
  onLongPress: () => void;
}): React.JSX.Element {
  const thumb = file.thumb;
  const [img, setImg] = useState<ShownImage | null>(() => (thumb ? peekImage(thumb) : null));
  useEffect(() => {
    if (img || !thumb) return;
    let live = true;
    loadImage(roomKey, thumb)
      .then(shown => live && setImg(shown))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, thumb?.blob]);
  const w = file.w ?? thumb?.w;
  const h = file.h ?? thumb?.h;
  // Tall videos are kept from towering over the chat.
  const ratio = Math.max(0.75, w && h ? w / h : 16 / 9);
  const sending = progress !== undefined && progress < 1;
  return (
    <Pressable onPress={() => onTap(() => !sending && onOpen(file))} onLongPress={onLongPress} delayLongPress={300} accessibilityLabel="Play video">
      <View style={[styles.video, {aspectRatio: ratio, backgroundColor: theme.surfaceAlt}]}>
        {img && <Image source={{uri: img.uri}} style={StyleSheet.absoluteFill} resizeMode="cover" />}
        {sending ? (
          <View style={styles.videoUploading} pointerEvents="none">
            <ActivityIndicator color="#fff" />
            <Text style={styles.overlayText}>{Math.round(progress! * 100)}%</Text>
          </View>
        ) : (
          <View style={styles.playCircle} pointerEvents="none">
            <Icon name="play" size={22} color="#fff" />
          </View>
        )}
        <View style={styles.durBadge} pointerEvents="none">
          <Icon name="video" size={12} color="#fff" />
          {file.dur ? <Text style={styles.durText}>{clock(file.dur)}</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}

/** A video, full screen, playing as it opens. `footer` holds the save and close buttons. */
export function VideoViewer({
  roomKey,
  file,
  onClose,
  footer,
}: {
  roomKey: string;
  file: FileRef;
  onClose: () => void;
  footer?: React.ReactNode;
}): React.JSX.Element {
  const {src, error, progress, load} = usePlayable(roomKey, file);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.blob]);
  return (
    <Overlay visible onClose={onClose} backdrop="#000" modal>
      <View style={styles.viewerArea}>
        {src ? (
          <VideoPlayer uri={src} style={styles.viewerVideo} />
        ) : error ? (
          <Pressable onPress={load} style={styles.viewerCenter}>
            <Text style={styles.viewerError}>Couldn't load the video · Tap to retry</Text>
          </Pressable>
        ) : (
          <View style={styles.viewerCenter}>
            {progress === null ? (
              <>
                <ActivityIndicator color="#fff" />
                <Text style={styles.overlayText}>Decrypting…</Text>
              </>
            ) : (
              <>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, {width: `${Math.round(progress * 100)}%`}]} />
                </View>
                <Text style={styles.overlayText}>
                  Downloading {Math.round(progress * 100)}% · {formatMB(progress * file.size)} of {formatMB(file.size)}
                </Text>
              </>
            )}
          </View>
        )}
      </View>
      {footer}
    </Overlay>
  );
}

const formatMB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// ---- voice ----

/** The voice message playing now: starting another stops it. */
let stopPlaying: (() => void) | null = null;

export function VoiceAttachment({
  roomKey,
  file,
  mine,
  color,
  theme,
  progress,
  onTap,
  onLongPress,
}: {
  roomKey: string;
  file: FileRef;
  mine: boolean;
  /** The bubble's text color. */
  color: string;
  theme: Theme;
  progress?: number;
  onTap: (single?: () => void) => void;
  onLongPress: () => void;
}): React.JSX.Element {
  const {src, error, loading, progress: downloaded, load} = usePlayable(roomKey, file);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [seekTo, setSeekTo] = useState<{at: number} | undefined>();
  const [width, setWidth] = useState(0);
  const bars = useMemo(() => barsOf(file.wave), [file.wave]);
  const dur = file.dur ?? 0;
  const stop = useRef(() => setPlaying(false));

  useEffect(
    () => () => {
      if (stopPlaying === stop.current) stopPlaying = null;
    },
    [],
  );

  const play = async () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (!(await load())) return;
    if (stopPlaying && stopPlaying !== stop.current) stopPlaying();
    stopPlaying = stop.current;
    setPlaying(true);
  };

  const seek = (x: number) => {
    if (!src || !dur || !width) return;
    const at = Math.max(0, Math.min(dur, (x / width) * dur));
    setPos(at);
    setSeekTo({at});
  };

  const sending = progress !== undefined && progress < 1;
  const played = dur ? Math.min(1, pos / dur) : 0;
  const buttonBg = mine ? 'rgba(255,255,255,0.22)' : theme.primary;
  const buttonFg = mine ? color : theme.primaryText;
  return (
    <View style={styles.voice}>
      <Pressable
        style={[styles.voiceButton, {backgroundColor: buttonBg}]}
        onPress={() => onTap(play)}
        onLongPress={onLongPress}
        delayLongPress={300}
        disabled={sending}
        accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}>
        {loading || sending ? (
          <ActivityIndicator size="small" color={buttonFg} />
        ) : (
          <Icon name={playing ? 'pause' : 'play'} size={16} color={buttonFg} />
        )}
      </Pressable>
      <Pressable
        style={styles.wave}
        onLayout={e => setWidth(e.nativeEvent.layout.width)}
        onPress={e => (src ? seek(e.nativeEvent.locationX) : onTap(play))}
        onLongPress={onLongPress}
        delayLongPress={300}>
        {bars.map((b, i) => (
          <View
            key={i}
            // Taps land on the row, so locationX is across the whole waveform, not within one bar.
            pointerEvents="none"
            style={[
              styles.bar,
              {height: 3 + (b / WAVE_MAX) * 19, backgroundColor: color, opacity: (i + 0.5) / bars.length <= played ? 1 : 0.45},
            ]}
          />
        ))}
      </Pressable>
      <Text style={[styles.voiceTime, {color}]}>{error ? '!' : downloaded !== null ? `${Math.round(downloaded * 100)}%` : clock(playing || pos > 0 ? pos : dur)}</Text>
      {src && (
        <AudioPlayer
          uri={src}
          playing={playing}
          seekTo={seekTo}
          onProgress={setPos}
          onEnd={() => {
            setPlaying(false);
            setPos(0);
          }}
        />
      )}
    </View>
  );
}

/** The composer while a voice message records: cancel, how long, the live level, send. */
export function RecordingBar({
  seconds,
  levels,
  theme,
  onCancel,
  onSend,
}: {
  seconds: number;
  /** Recent loudness, 0–1, newest last. */
  levels: number[];
  theme: Theme;
  onCancel: () => void;
  onSend: () => void;
}): React.JSX.Element {
  const blink = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, {toValue: 0.25, duration: 500, easing: Easing.inOut(Easing.quad), useNativeDriver: true}),
        Animated.timing(blink, {toValue: 1, duration: 500, easing: Easing.inOut(Easing.quad), useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [blink]);
  return (
    <View style={[styles.recRow, {borderTopColor: theme.border, backgroundColor: theme.bg}]}>
      <Pressable style={[styles.recButton, {backgroundColor: theme.surfaceAlt}]} onPress={onCancel} accessibilityLabel="Discard voice message">
        <Icon name="trash" size={18} color={theme.danger} />
      </Pressable>
      <View style={[styles.recBar, {backgroundColor: theme.surface, borderColor: theme.border}]}>
        <Animated.View style={[styles.recDot, {backgroundColor: theme.danger, opacity: blink}]} />
        <Text style={[styles.recTime, {color: theme.text}]}>{clock(seconds)}</Text>
        <View style={styles.recWave}>
          {levels.map((l, i) => (
            <View key={i} style={[styles.bar, {height: 3 + l * 19, backgroundColor: theme.textMuted}]} />
          ))}
        </View>
      </View>
      <Pressable style={[styles.recSend, {backgroundColor: theme.primary}]} onPress={onSend} accessibilityLabel="Send voice message">
        <Icon name="send" size={18} color={theme.primaryText} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  video: {width: 240, maxWidth: '100%', borderRadius: 6, overflow: 'hidden', alignItems: 'center', justifyContent: 'center'},
  playCircle: {width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', paddingLeft: 3},
  videoUploading: {...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.35)'},
  overlayText: {color: '#fff', fontSize: 12, fontWeight: '600'},
  durBadge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  durText: {color: '#fff', fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums']},
  viewerArea: {flex: 1, justifyContent: 'center'},
  viewerVideo: {width: '100%', height: '100%'},
  viewerCenter: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8},
  viewerError: {color: '#ff9b9b', textAlign: 'center', padding: 20},
  progressTrack: {width: 220, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden'},
  progressFill: {height: 4, borderRadius: 2, backgroundColor: '#fff'},
  voice: {flexDirection: 'row', alignItems: 'center', gap: 10, width: 240, maxWidth: '100%', paddingVertical: 2},
  voiceButton: {width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center'},
  wave: {flex: 1, height: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  bar: {width: 3, borderRadius: 1.5},
  voiceTime: {fontSize: 12, fontVariant: ['tabular-nums'], minWidth: 32, textAlign: 'right'},
  recRow: {flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderTopWidth: 1},
  recButton: {width: 40, height: 40, borderRadius: 6, alignItems: 'center', justifyContent: 'center'},
  recBar: {flex: 1, height: 40, borderRadius: 6, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10},
  recDot: {width: 9, height: 9, borderRadius: 4.5},
  recTime: {fontSize: 13, fontVariant: ['tabular-nums'], minWidth: 34},
  recWave: {flex: 1, height: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2, overflow: 'hidden'},
  recSend: {minHeight: 40, borderRadius: 6, paddingHorizontal: 16, justifyContent: 'center'},
});
