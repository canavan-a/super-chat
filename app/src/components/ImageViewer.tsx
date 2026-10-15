import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, Easing, Image, PanResponder, StyleSheet, View} from 'react-native';

import {Overlay} from './Overlay';

const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;
// How far (as a share of the height), or how fast, a swipe has to go to close.
const DISMISS_SHARE = 0.15;
const DISMISS_VELOCITY = 0.8;

/**
 * A photo, full screen. Swipe it up or down to close (it follows the finger
 * and flies off), pinch to zoom, drag to pan while zoomed, double-tap to zoom
 * in on a spot or back out. Plain PanResponder + Animated, so it needs no
 * native gesture library and works the same in the browser.
 */
export function ImageViewer({
  uri,
  onClose,
  footer,
}: {
  uri: string;
  onClose: () => void;
  /** Buttons under the photo (save, close). */
  footer?: React.ReactNode;
}): React.JSX.Element {
  const [area, setArea] = useState({w: 0, h: 0});
  const [natural, setNatural] = useState<{w: number; h: number} | null>(null);

  const zoom = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current; // the swipe-to-close offset
  const shown = useRef(new Animated.Value(0)).current; // 0 → 1 as it opens

  useEffect(() => {
    Animated.timing(shown, {toValue: 1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true}).start();
    Image.getSize(uri, (w, h) => setNatural({w, h}), () => {});
  }, [uri, shown]);

  // Gesture state lives in refs: the responder is created once.
  const cur = useRef({z: 1, tx: 0, ty: 0});
  const areaRef = useRef(area);
  areaRef.current = area;
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /** The photo's on-screen size at zoom 1 (fitted inside the area). */
  const fitted = () => {
    const {w, h} = areaRef.current;
    const n = naturalRef.current;
    if (!n || !n.w || !n.h) return {w, h};
    const s = Math.min(w / n.w, h / n.h);
    return {w: n.w * s, h: n.h * s};
  };
  /** Keeps a zoomed photo covering the area where it can, centered where it can't. */
  const clamp = (z: number, x: number, y: number) => {
    const zz = Math.min(MAX_ZOOM, Math.max(1, z));
    const f = fitted();
    const mx = Math.max(0, (f.w * zz - areaRef.current.w) / 2);
    const my = Math.max(0, (f.h * zz - areaRef.current.h) / 2);
    return {z: zz, tx: Math.min(mx, Math.max(-mx, x)), ty: Math.min(my, Math.max(-my, y))};
  };
  const set = (v: {z: number; tx: number; ty: number}) => {
    cur.current = v;
    zoom.setValue(v.z);
    tx.setValue(v.tx);
    ty.setValue(v.ty);
  };
  const animateTo = (v: {z: number; tx: number; ty: number}) => {
    cur.current = v;
    const spring = (a: Animated.Value, to: number) => Animated.spring(a, {toValue: to, useNativeDriver: true, bounciness: 0, speed: 18});
    Animated.parallel([spring(zoom, v.z), spring(tx, v.tx), spring(ty, v.ty)]).start();
  };

  const dismiss = (dir: number) => {
    const h = areaRef.current.h || 800;
    Animated.parallel([
      Animated.timing(drag, {toValue: dir * h, duration: 180, easing: Easing.in(Easing.quad), useNativeDriver: true}),
      Animated.timing(shown, {toValue: 0, duration: 180, useNativeDriver: true}),
    ]).start(() => onCloseRef.current());
  };

  const gesture = useRef<{
    // settle: a pinch that's down to one finger; it only snaps back on release.
    mode: 'none' | 'dismiss' | 'pan' | 'pinch' | 'settle';
    start: {z: number; tx: number; ty: number};
    dx: number;
    dy: number;
    dist: number;
    touches: number;
    moved: boolean;
    at: number;
  } | null>(null);
  const lastTap = useRef(0);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          gesture.current = {mode: 'none', start: cur.current, dx: 0, dy: 0, dist: 0, touches: 1, moved: false, at: Date.now()};
        },
        onPanResponderMove: (e, g) => {
          const st = gesture.current;
          if (!st) return;
          const t = e.nativeEvent.touches;
          const touches = Math.max(1, Math.min(2, t.length)); // a mouse reports none
          const dist = touches === 2 ? Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY) : 0;
          if (Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6) st.moved = true;
          // Start over whenever a finger is added or lifted, from where things are now.
          if (st.touches !== touches || st.mode === 'none') {
            if (st.mode === 'dismiss' && touches === 2) {
              drag.setValue(0);
            }
            st.touches = touches;
            st.start = cur.current;
            st.dx = g.dx;
            st.dy = g.dy;
            st.dist = dist;
            const wasPinch = st.mode === 'pinch' || st.mode === 'settle';
            st.mode = touches === 2 ? 'pinch' : cur.current.z > 1.01 ? 'pan' : wasPinch ? 'settle' : st.moved ? 'dismiss' : 'none';
            return;
          }
          if (st.mode === 'dismiss') {
            drag.setValue(g.dy - st.dy);
          } else if (st.mode === 'pinch' && st.dist > 0) {
            // Zoom about the pinch's midpoint as well as following it.
            const z = Math.min(MAX_ZOOM, Math.max(0.6, (st.start.z * dist) / st.dist));
            set({z, tx: st.start.tx * (z / st.start.z) + g.dx - st.dx, ty: st.start.ty * (z / st.start.z) + g.dy - st.dy});
          } else if (st.mode === 'pan') {
            set(clamp(st.start.z, st.start.tx + g.dx - st.dx, st.start.ty + g.dy - st.dy));
          }
        },
        onPanResponderRelease: (e, g) => {
          const st = gesture.current;
          gesture.current = null;
          if (!st) return;
          if (st.mode === 'dismiss') {
            const dy = g.dy - st.dy;
            if (Math.abs(dy) > (areaRef.current.h || 800) * DISMISS_SHARE || Math.abs(g.vy) > DISMISS_VELOCITY) {
              dismiss(Math.sign(dy || g.vy) || 1);
            } else {
              Animated.spring(drag, {toValue: 0, useNativeDriver: true, bounciness: 6}).start();
            }
            return;
          }
          if (st.mode === 'pinch' || st.mode === 'pan' || st.mode === 'settle') {
            const c = clamp(cur.current.z, cur.current.tx, cur.current.ty);
            animateTo(c.z <= 1.01 ? {z: 1, tx: 0, ty: 0} : c);
            return;
          }
          // A tap: two in quick succession zoom in on that spot, or back out.
          if (!st.moved && Date.now() - st.at < 250) {
            const now = Date.now();
            if (now - lastTap.current < DOUBLE_TAP_MS) {
              lastTap.current = 0;
              if (cur.current.z > 1.01) {
                animateTo({z: 1, tx: 0, ty: 0});
              } else {
                const {w, h} = areaRef.current;
                const ox = e.nativeEvent.locationX - w / 2;
                const oy = e.nativeEvent.locationY - h / 2;
                animateTo(clamp(DOUBLE_TAP_ZOOM, -ox * (DOUBLE_TAP_ZOOM - 1), -oy * (DOUBLE_TAP_ZOOM - 1)));
              }
            } else {
              lastTap.current = now;
            }
          }
        },
        onPanResponderTerminate: () => {
          gesture.current = null;
          Animated.spring(drag, {toValue: 0, useNativeDriver: true}).start();
          animateTo(clamp(cur.current.z, cur.current.tx, cur.current.ty));
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The further it's dragged, the smaller the photo and the fainter the backdrop.
  const h = area.h || 800;
  const dragFade = drag.interpolate({inputRange: [-h, 0, h], outputRange: [0, 1, 0], extrapolate: 'clamp'});
  const dragShrink = drag.interpolate({inputRange: [-h, 0, h], outputRange: [0.8, 1, 0.8], extrapolate: 'clamp'});
  const opening = shown.interpolate({inputRange: [0, 1], outputRange: [0.94, 1]});

  return (
    <Overlay visible onClose={onClose} backdrop="transparent">
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, {opacity: Animated.multiply(shown, dragFade)}]} />
      <View style={styles.area} onLayout={e => setArea({w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height})} {...responder.panHandlers}>
        <Animated.Image
          source={{uri}}
          resizeMode="contain"
          style={[
            styles.image,
            {
              opacity: shown,
              transform: [
                {translateX: tx},
                {translateY: Animated.add(ty, drag)},
                {scale: Animated.multiply(Animated.multiply(zoom, dragShrink), opening)},
              ],
            },
          ]}
        />
      </View>
      {footer ? <Animated.View style={{opacity: Animated.multiply(shown, dragFade)}}>{footer}</Animated.View> : null}
    </Overlay>
  );
}

const styles = StyleSheet.create({
  backdrop: {backgroundColor: 'rgba(0,0,0,0.92)'},
  area: {flex: 1, overflow: 'hidden'},
  image: {width: '100%', height: '100%'},
});
