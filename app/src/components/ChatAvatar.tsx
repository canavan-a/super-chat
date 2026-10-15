import React, {useEffect, useState} from 'react';
import {Image, View} from 'react-native';

import {AvatarRef, FileRef} from '../crypto';
import {chatFaces, getRoom, loadImage, peekImage, useStore} from '../store';
import {useTheme} from '../theme';
import {Avatar} from './Avatar';

const asFile = (r: AvatarRef): FileRef => ({blob: r.blob, key: r.key, name: 'picture.jpg', mime: 'image/jpeg', size: 0});

/**
 * A chat's picture: the other person's in a one-to-one chat, the group
 * picture otherwise (see chatPicture). A group with no picture shows a
 * cluster of up to three members (see chatFaces); otherwise it's a disc in
 * the chat's color (also while loading). Keyed on the blob id, like Avatar.
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
  const faces = useStore(() => (picture ? [] : chatFaces(getRoom(roomKey))));
  const names = useStore(() => getRoom(roomKey)?.view?.names);
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
  if (faces.length >= 2) {
    // Two on a diagonal, or three in a triangle; the latest speaker on top.
    const f = Math.round(size * (faces.length === 2 ? 0.64 : 0.56));
    const spots =
      faces.length === 2
        ? [{left: 0, top: 0}, {right: 0, bottom: 0}]
        : [{left: (size - f) / 2, top: 0}, {left: 0, bottom: 0}, {right: 0, bottom: 0}];
    return (
      <View style={{width: size, height: size}}>
        {faces
          .map((id, i) => (
            <View
              key={id}
              style={[spots[i], {position: 'absolute', borderRadius: f / 2, borderWidth: 1.5, borderColor: theme.bg}]}>
              <Avatar roomKey={roomKey} member={id} name={names?.[id]} size={f - 3} />
            </View>
          ))
          .reverse()}
      </View>
    );
  }
  return <View style={[box, {backgroundColor: color}]} />;
}
