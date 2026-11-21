// Browser version of MediaPlayer.tsx: an <audio> element kept off screen, and
// a plain <video> with the browser's controls.
import React, {useEffect, useRef} from 'react';
import {ViewStyle} from 'react-native';

export function AudioPlayer({
  uri,
  playing,
  seekTo,
  onProgress,
  onEnd,
}: {
  uri: string;
  playing: boolean;
  seekTo?: {at: number};
  onProgress: (seconds: number) => void;
  onEnd: () => void;
}): React.JSX.Element | null {
  const audio = useRef<HTMLAudioElement | null>(null);
  const handlers = useRef({onProgress, onEnd});
  handlers.current = {onProgress, onEnd};

  useEffect(() => {
    const a = new Audio(uri);
    audio.current = a;
    let raf = 0;
    const tickProgress = () => {
      handlers.current.onProgress(a.currentTime);
      raf = requestAnimationFrame(tickProgress);
    };
    a.onplay = () => (raf = requestAnimationFrame(tickProgress));
    a.onpause = () => cancelAnimationFrame(raf);
    a.onended = () => {
      cancelAnimationFrame(raf);
      a.currentTime = 0;
      handlers.current.onEnd();
    };
    return () => {
      cancelAnimationFrame(raf);
      a.pause();
      a.src = '';
      audio.current = null;
    };
  }, [uri]);

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    if (playing) a.play().catch(() => handlers.current.onEnd());
    else a.pause();
  }, [playing, uri]);

  useEffect(() => {
    if (seekTo && audio.current) audio.current.currentTime = seekTo.at;
  }, [seekTo]);

  return null;
}

// style is for the native player; the <video> always fills its box.
export function VideoPlayer({uri}: {uri: string; style?: ViewStyle}): React.JSX.Element {
  return React.createElement('video', {
    src: uri,
    controls: true,
    autoPlay: true,
    playsInline: true,
    controlsList: 'nodownload',
    style: {width: '100%', height: '100%', objectFit: 'contain', background: '#000'},
  });
}
