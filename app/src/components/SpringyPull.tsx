import React, {useMemo, useRef, useState} from 'react';
import {Animated, PanResponder, Platform, StyleSheet, View} from 'react-native';

import {useTheme} from '../theme';
import {TypingDots} from './TypingDots';

/** How far to pull (after resistance) before letting go refreshes. */
const TRIGGER = 70;
/** The dots stop after this even if the refresh is still going. */
const MAX_SPIN_MS = 2500;

/** Rubber-band resistance: follows the finger at first, then less and less. */
const rubber = (dy: number) => 140 * (1 - Math.exp(-Math.max(0, dy) / 200));

/**
 * A springy pull-to-refresh around a scrollable list. Pulled down from the
 * top, the list follows the finger with rubber-band resistance while the
 * app's three pixel dots grow in above it; let go past the line and it
 * springs straight back while `onRefresh` runs behind it, shown only by a
 * small bouncing-dots pill at the top that touches pass through. No text,
 * and nothing is blocked. `atTop` says whether the list is scrolled to its
 * top (the pull only starts there).
 */
export function SpringyPull({
  atTop,
  onRefresh,
  background,
  children,
}: {
  atTop: () => boolean;
  onRefresh: () => Promise<void>;
  /** Drawn behind everything and given the live pull distance (e.g. PixelField). */
  background?: (pull: Animated.Value) => React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  const pull = useRef(new Animated.Value(0)).current;
  const [phase, setPhase] = useState<'idle' | 'pulling' | 'armed' | 'refreshing'>('idle');
  const busy = useRef(false);
  const useNative = Platform.OS !== 'web';

  const springTo = (to: number, done?: () => void) =>
    Animated.spring(pull, {toValue: to, useNativeDriver: useNative, tension: 120, friction: to === 0 ? 7 : 9}).start(done);

  // The list springs straight back on release and stays usable; the refresh
  // runs behind it, shown only by the small dots overlay at the top.
  const refresh = async () => {
    busy.current = true;
    setPhase('refreshing');
    springTo(0);
    // A beat of bounce even when the refresh is instant, so it reads; and
    // never more than a couple of seconds: whatever is still loading after
    // that lands quietly on its own.
    const work = onRefresh().catch(() => {});
    await Promise.all([
      Promise.race([work, new Promise(r => setTimeout(r, MAX_SPIN_MS))]),
      new Promise(r => setTimeout(r, 600)),
    ]);
    busy.current = false;
    setPhase('idle');
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Claim the drag before the list does, but only for a downward pull
        // at the top. Pulling works at any time, a refresh in progress
        // included: then it just springs back.
        // A clear downward drag only: a tap's few pixels of wobble mustn't
        // be taken for a pull (that swallowed taps on the rooms).
        onMoveShouldSetPanResponderCapture: (_e, g) =>
          atTop() && g.dy > 14 && Math.abs(g.dy) > Math.abs(g.dx) * 2,
        onPanResponderGrant: () => {
          if (!busy.current) setPhase('pulling');
        },
        onPanResponderMove: (_e, g) => {
          const d = rubber(g.dy);
          pull.setValue(d);
          if (!busy.current) setPhase(p => (d >= TRIGGER ? (p === 'armed' ? p : 'armed') : p === 'pulling' ? p : 'pulling'));
        },
        onPanResponderRelease: (_e, g) => {
          if (!busy.current && rubber(g.dy) >= TRIGGER) refresh();
          else springTo(0, () => !busy.current && setPhase('idle'));
        },
        onPanResponderTerminate: () => springTo(0, () => !busy.current && setPhase('idle')),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const progress = pull.interpolate({inputRange: [0, TRIGGER], outputRange: [0, 1], extrapolate: 'clamp'});
  return (
    <View style={styles.fill} {...responder.panHandlers}>
      {background?.(pull)}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.indicator,
          {
            opacity: progress,
            transform: [
              {translateY: pull.interpolate({inputRange: [0, 140], outputRange: [-24, 46], extrapolate: 'clamp'})},
              {scale: progress.interpolate({inputRange: [0, 1], outputRange: [0.6, 1]})},
            ],
          },
        ]}>
        <View style={styles.dots}>
          {[0, 1, 2].map(i => (
            <View key={i} style={[styles.dot, {backgroundColor: phase === 'armed' ? theme.primary : theme.textMuted}]} />
          ))}
        </View>
      </Animated.View>
      <Animated.View style={[styles.fill, {transform: [{translateY: pull}]}]}>{children}</Animated.View>
      {phase === 'refreshing' && (
        // Over the list, out of the way of touches: only the bouncing dots.
        <View pointerEvents="none" style={styles.busy}>
          <View style={[styles.busyPill, {backgroundColor: theme.surface, borderColor: theme.border}]}>
            <TypingDots color={theme.primary} size={6} />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {flex: 1},
  indicator: {position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', gap: 6},
  dots: {flexDirection: 'row', gap: 4},
  dot: {width: 7, height: 7},
  busy: {position: 'absolute', top: 8, left: 0, right: 0, alignItems: 'center'},
  busyPill: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, borderWidth: 1},
});
