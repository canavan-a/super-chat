import React, {useEffect, useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';

import {fingerprint, FileRef} from '../crypto';
import {avatarsOf, getRoom, loadImage, peekImage, useStore} from '../store';
import {useTheme} from '../theme';

const asFile = (r: {blob: string; key: string}): FileRef => ({blob: r.blob, key: r.key, name: 'avatar.jpg', mime: 'image/jpeg', size: 0});

/**
 * A member's profile picture in a room, or their initial on a colored disc
 * when they have none (or it hasn't loaded yet). Keyed on the picture's blob
 * id: a changed picture is a new blob, which is what triggers a refetch, and
 * an unchanged one comes straight from memory or the device cache. Until the
 * room's log loads, last launch's picture shows (store.avatarsOf).
 */
export function Avatar({roomKey, member, name, size = 32}: {roomKey: string; member: string; name?: string | null; size?: number}) {
  const theme = useTheme();
  const ref = useStore(() => avatarsOf(getRoom(roomKey))[member] ?? null);
  const blob = ref?.blob ?? null;
  // From memory at once when it's been shown before (avatars repeat a lot).
  // Whose picture is up: a row reused for someone else never shows the last one's.
  const who = `${roomKey}|${member}`;
  const [shown, setShown] = useState<{who: string; uri: string} | null>(() => {
    const now = ref ? peekImage(asFile(ref)) : null;
    return now ? {who, uri: now.uri} : null;
  });
  const setUri = (u: string | null) => setShown(u ? {who, uri: u} : null);
  const uri = shown?.who === who ? shown.uri : null;

  useEffect(() => {
    if (!ref) {
      setUri(null);
      return;
    }
    const now = peekImage(asFile(ref));
    if (now) {
      setUri(now.uri);
      return;
    }
    // A changed picture: the old one stays up until the new one is ready
    // (no flash back to the initial). A failed load keeps it too.
    let live = true;
    loadImage(roomKey, asFile(ref))
      .then(img => live && setUri(img.uri))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, member, blob]);

  const box = {width: size, height: size, borderRadius: size / 2};
  if (uri) return <Image source={{uri}} style={[box, {backgroundColor: theme.surfaceAlt}]} />;
  const label = (name || fingerprint(member)).trim().charAt(0).toUpperCase() || '?';
  return (
    <View style={[box, styles.fallback, {backgroundColor: hueFor(member)}]}>
      <Text style={[styles.initial, {fontSize: size * 0.45}]}>{label}</Text>
    </View>
  );
}

/** A steady color per member, so a fallback disc is recognisable. */
function hueFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 45%)`;
}

const styles = StyleSheet.create({
  fallback: {alignItems: 'center', justifyContent: 'center'},
  initial: {color: '#fff', fontWeight: '700'},
});
