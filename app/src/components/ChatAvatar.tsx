import React, {useEffect, useState} from 'react';
import {Image, View} from 'react-native';

import {AvatarRef, FileRef} from '../crypto';
import {loadImage, peekImage} from '../store';
import {useTheme} from '../theme';

const asFile = (r: AvatarRef): FileRef => ({blob: r.blob, key: r.key, name: 'picture.jpg', mime: 'image/jpeg', size: 0});

/**
 * A chat's picture: the other person's in a one-to-one chat, the group
 * picture otherwise (see chatPicture), or a disc in the chat's color when
 * there's none (or it hasn't loaded yet). Keyed on the blob id, like Avatar.
 */
export function ChatAvatar({
  roomKey,
  picture,
  color,
  size = 40,
}: {
  roomKey: string;
  picture: AvatarRef | null;
  color: string;
  size?: number;
}) {
  const theme = useTheme();
  const blob = picture?.blob ?? null;
  const [uri, setUri] = useState<string | null>(() => (picture ? peekImage(asFile(picture))?.uri ?? null : null));

  useEffect(() => {
    if (!picture) {
      setUri(null);
      return;
    }
    const now = peekImage(asFile(picture));
    if (now) {
      setUri(now.uri);
      return;
    }
    setUri(null);
    let live = true;
    loadImage(roomKey, asFile(picture))
      .then(shown => live && setUri(shown.uri))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, blob]);

  const box = {width: size, height: size, borderRadius: size / 2};
  if (uri) return <Image source={{uri}} style={[box, {backgroundColor: theme.surfaceAlt}]} />;
  return <View style={[box, {backgroundColor: color}]} />;
}
