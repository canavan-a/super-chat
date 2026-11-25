// A plain 0–1 slider (drag or tap anywhere on the track), so the app needs
// no slider dependency. Works the same on native and web.
import React, {useRef} from 'react';
import {GestureResponderEvent, StyleSheet, View} from 'react-native';

import {Theme} from '../theme';

const STEP = 0.1;

export function VolumeSlider({
  value,
  onChange,
  theme,
  dimmed,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  theme: Theme;
  /** Drawn greyed out (e.g. while muted), but still draggable. */
  dimmed?: boolean;
  label: string;
}): React.JSX.Element {
  const ref = useRef<View>(null);
  const geo = useRef({x: 0, w: 1});
  const measure = () =>
    ref.current?.measure((_x, _y, w, _h, pageX) => {
      geo.current = {x: pageX, w: Math.max(1, w)};
    });
  const at = (e: GestureResponderEvent) =>
    Math.min(1, Math.max(0, (e.nativeEvent.pageX - geo.current.x) / geo.current.w));
  const pct = Math.round(value * 100);
  const color = dimmed ? theme.textMuted : theme.primary;
  return (
    <View
      ref={ref}
      onLayout={measure}
      style={styles.hit}
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{min: 0, max: 100, now: pct, text: `${pct}%`}}
      accessibilityActions={[{name: 'increment'}, {name: 'decrement'}]}
      onAccessibilityAction={e =>
        onChange(
          Math.min(
            1,
            Math.max(0, value + (e.nativeEvent.actionName === 'increment' ? STEP : -STEP)),
          ),
        )
      }
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={e => {
        measure();
        onChange(at(e));
      }}
      onResponderMove={e => onChange(at(e))}>
      <View style={[styles.rail, {backgroundColor: theme.border}]} pointerEvents="none">
        <View style={[styles.fill, {width: `${pct}%`, backgroundColor: color}]} />
      </View>
      <View
        pointerEvents="none"
        style={[
          styles.thumb,
          {left: `${pct}%`, backgroundColor: color, borderColor: theme.surface},
        ]}
      />
    </View>
  );
}

const THUMB = 20;

const styles = StyleSheet.create({
  hit: {height: 36, justifyContent: 'center', marginHorizontal: THUMB / 2},
  rail: {height: 4, borderRadius: 2, overflow: 'hidden'},
  fill: {height: 4},
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    marginLeft: -THUMB / 2,
    borderRadius: THUMB / 2,
    borderWidth: 2,
  },
});
