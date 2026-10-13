import React, {useEffect, useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';

import {fingerprint} from '../crypto';
import {dataUri} from '../files';
import {fetchAvatar, getRoom, useStore} from '../store';
import {useTheme} from '../theme';

/**
 * A member's profile picture in a room, or their initial on a colored disc
 * when they have none (or it hasn't loaded yet). Keyed on the picture's blob
 * id: a changed picture is a new blob, which is what triggers a refetch, and
 * an unchanged one comes straight from the device cache.
 */
export function Avatar({roomKey, member, name, size = 32}: {roomKey: string; member: string; name?: string | null; size?: number}) {
  const theme = useTheme();
  const blob = useStore(() => getRoom(roomKey)?.view?.avatars[member]?.blob ?? null);
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    setUri(null);
    if (!blob) return;
    let live = true;
    fetchAvatar(roomKey, member)
      .then(data => live && data && setUri(dataUri('image/jpeg', data)))
      .catch(() => {});
    return () => {
      live = false;
    };
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
