// Playing videos and voice messages on Android and iOS, through
// react-native-video. MediaPlayer.web.tsx is the browser version.
import React, {useEffect, useRef} from 'react';
import {StyleSheet, ViewStyle} from 'react-native';
import Video, {VideoRef, ViewType} from 'react-native-video';

/**
 * A voice message's sound, with nothing on screen: the bubble draws the
 * controls. Plays while `playing`; back to the start once it ends.
 */
export function AudioPlayer({
  uri,
  playing,
  seekTo,
  onProgress,
  onEnd,
}: {
  uri: string;
  playing: boolean;
  /** Changes to this (in seconds) jump there. */
  seekTo?: {at: number};
  onProgress: (seconds: number) => void;
  onEnd: () => void;
}): React.JSX.Element {
  const ref = useRef<VideoRef>(null);
  useEffect(() => {
    if (seekTo) ref.current?.seek(seekTo.at);
  }, [seekTo]);
  return (
    <Video
      ref={ref}
      source={{uri}}
      paused={!playing}
      style={styles.hidden}
      progressUpdateInterval={100}
      ignoreSilentSwitch="ignore"
      playInBackground={false}
      onProgress={e => onProgress(e.currentTime)}
      onEnd={() => {
        ref.current?.seek(0);
        onEnd();
      }}
    />
  );
}

/** A video, full size with the platform's own controls, playing as it opens. */
export function VideoPlayer({uri, style}: {uri: string; style?: ViewStyle}): React.JSX.Element {
  return (
    <Video
      source={{uri}}
      style={style}
      controls
      resizeMode="contain"
      ignoreSilentSwitch="ignore"
      playInBackground={false}
      // A TextureView draws into the app's own window, so FLAG_SECURE keeps
      // it out of screenshots; the default SurfaceView has its own surface.
      viewType={ViewType.TEXTURE}
    />
  );
}

const styles = StyleSheet.create({hidden: {width: 0, height: 0}});
