import React, {useEffect, useMemo, useRef, useState} from 'react';
import {AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View} from 'react-native';

import {toneColor} from '../logo/logoTheme';
import {useTheme} from '../theme';

/** How many pixels drift behind the list. */
const COUNT = 33;

/** A seeded random stream, so the constellation is the same pattern every launch. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A subdued constellation of the logo's square pixels drifting up behind the
 * room list, each on its own slow sway, at its own depth, some twinkling.
 * Pulling the list down (`pull`, from SpringyPull) pushes them along their
 * paths in proportion to the pull, nearer ones further, like a burst of speed.
 *
 * Everything is declarative Animated math on one clock and the pull, so on
 * Android it runs on the native driver and costs the JS thread nothing.
 */
export function PixelField({pull}: {pull: Animated.Value}): React.JSX.Element | null {
  const theme = useTheme();
  const [size, setSize] = useState({w: 0, h: 0});
  const [still, setStill] = useState(false);
  const native = Platform.OS !== 'web';

  // One slow clock: 1 unit per second.
  const clock = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled?.())
      .then(v => setStill(!!v))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (still) return;
    const run = Animated.timing(clock, {
      toValue: 1_000_000,
      duration: 1_000_000_000,
      easing: Easing.linear,
      useNativeDriver: native,
    });
    run.start();
    return () => run.stop();
  }, [clock, still, native]);

  // The pattern itself: positions, depths, colors and timings.
  const pixels = useMemo(() => {
    const rnd = seeded(0x5c);
    const colors = [toneColor(theme, 4, 1), toneColor(theme, 3.5, 0.5), toneColor(theme, 3, 0)];
    return Array.from({length: COUNT}, (_, i) => {
      const depth = 0.35 + rnd() * 0.65; // 1 = nearest
      return {
        x: (i + rnd() * 0.8) / COUNT, // spread across the width
        offset: rnd(), // where on its path it starts
        speed: 4 + depth * 10, // px per second
        sway: 6 + rnd() * 18, // px
        swayPeriod: 7 + rnd() * 9, // s
        twinkle: rnd() < 0.4 ? 3 + rnd() * 4 : 0, // s, or none
        size: Math.round(2 + depth * 4),
        opacity: 0.06 + depth * 0.12,
        color: colors[Math.floor(rnd() * colors.length)],
        depth,
      };
    });
  }, [theme]);

  const {w, h} = size;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={e => setSize({w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height})}>
      {w > 0 &&
        pixels.map((p, i) => {
          const span = h + 20;
          // Distance travelled: the clock at this pixel's speed, plus a push
          // from the pull (nearer pixels further), wrapped to the screen.
          const travelled = Animated.add(
            Animated.add(Animated.multiply(clock, p.speed), Animated.multiply(pull, 1.2 + p.depth * 2.4)),
            p.offset * span,
          );
          const y = Animated.subtract(h + 10, Animated.modulo(travelled, span));
          const phase = Animated.modulo(Animated.multiply(clock, 1 / p.swayPeriod), 1);
          const x = phase.interpolate({inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [0, p.sway, 0, -p.sway, 0]});
          const opacity = p.twinkle
            ? Animated.modulo(Animated.multiply(clock, 1 / p.twinkle), 1).interpolate({
                inputRange: [0, 0.5, 1],
                outputRange: [p.opacity * 0.35, p.opacity, p.opacity * 0.35],
              })
            : p.opacity;
          return (
            <Animated.View
              key={i}
              style={{
                position: 'absolute',
                left: p.x * w,
                top: 0,
                width: p.size,
                height: p.size,
                backgroundColor: p.color,
                opacity,
                transform: [{translateX: x}, {translateY: y}],
              }}
            />
          );
        })}
    </View>
  );
}
