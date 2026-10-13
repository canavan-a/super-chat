import React, {useMemo, useRef, useState} from 'react';
import {Animated, PanResponder, Platform, StyleSheet, Text, View} from 'react-native';

import {useTheme} from '../theme';
import {TypingDots} from './TypingDots';

/** How far to pull (after resistance) before letting go refreshes. */
const TRIGGER = 70;
/** Where the content rests while refreshing, leaving room for the dots. */
const REST = 56;

/** Rubber-band resistance: follows the finger at first, then less and less. */
const rubber = (dy: number) => 140 * (1 - Math.exp(-Math.max(0, dy) / 200));

/**
 * A springy pull-to-refresh around a scrollable list. Pulled down from the
 * top, the list follows the finger with rubber-band resistance while the
 * app's three pixel dots grow in above it; let go past the line and it
 * springs to a rest while the dots bounce and `onRefresh` runs, then springs
 * back. `atTop` says whether the list is scrolled to its top (the pull only
 * starts there).
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

  const refresh = async () => {
    busy.current = true;
    setPhase('refreshing');
    springTo(REST);
    // A beat of bounce even when the refresh is instant, so it reads.
    await Promise.all([onRefresh().catch(() => {}), new Promise(r => setTimeout(r, 600))]);
    springTo(0, () => {
      busy.current = false;
      setPhase('idle');
    });
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Claim the drag before the list does, but only for a downward pull at the top.
        onMoveShouldSetPanResponderCapture: (_e, g) =>
          !busy.current && atTop() && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
        onPanResponderGrant: () => setPhase('pulling'),
        onPanResponderMove: (_e, g) => {
          const d = rubber(g.dy);
          pull.setValue(d);
          setPhase(p => (d >= TRIGGER ? (p === 'armed' ? p : 'armed') : p === 'pulling' ? p : 'pulling'));
        },
        onPanResponderRelease: (_e, g) => {
          if (rubber(g.dy) >= TRIGGER) refresh();
          else springTo(0, () => setPhase('idle'));
        },
        onPanResponderTerminate: () => springTo(0, () => setPhase('idle')),
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
        {phase === 'refreshing' ? (
          <TypingDots color={theme.primary} size={7} />
        ) : (
          <View style={styles.dots}>
            {[0, 1, 2].map(i => (
              <View key={i} style={[styles.dot, {backgroundColor: phase === 'armed' ? theme.primary : theme.textMuted}]} />
            ))}
          </View>
        )}
        <Text style={[styles.label, {color: theme.textMuted}]}>
          {phase === 'refreshing' ? 'Catching up…' : phase === 'armed' ? 'Release to refresh' : 'Pull to refresh'}
        </Text>
      </Animated.View>
      <Animated.View style={[styles.fill, {transform: [{translateY: pull}]}]}>{children}</Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {flex: 1},
  indicator: {position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', gap: 6},
  dots: {flexDirection: 'row', gap: 4},
  dot: {width: 7, height: 7},
  label: {fontSize: 11, fontWeight: '600'},
});
