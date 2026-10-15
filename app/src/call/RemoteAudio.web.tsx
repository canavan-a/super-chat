// Plays everyone's voice in the browser: one hidden <audio> per peer,
// mounted in App.tsx (not the voice screen) so it keeps playing while you
// browse other rooms. Also applies the chosen output device, and notices
// when the browser won't start audio without a tap.
import React, {useEffect, useRef} from 'react';

import {useVoice, voice} from './voice';

function PeerAudio({
  stream,
  sinkId,
}: {
  stream: MediaStream;
  sinkId: string | null;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    el.play()
      .then(() => voice.setAudioBlocked(false))
      .catch(() => voice.setAudioBlocked(true));
  }, [stream]);
  useEffect(() => {
    const el = ref.current as any;
    if (el && sinkId && typeof el.setSinkId === 'function')
      el.setSinkId(sinkId).catch(() => {});
  }, [sinkId]);
  return React.createElement('audio', {
    ref,
    autoPlay: true,
    playsInline: true,
    style: {display: 'none'},
  });
}

export function RemoteAudio(): React.JSX.Element | null {
  const v = useVoice();
  // Re-read on every view change: streams arrive with ontrack.
  const streams = v.phase === 'idle' ? [] : voice.remoteStreams();
  // A tap anywhere retries playback the browser blocked.
  useEffect(() => {
    if (!v.audioBlocked) return;
    const retry = () => {
      document.querySelectorAll('audio').forEach(a => {
        a.play()
          .then(() => voice.setAudioBlocked(false))
          .catch(() => {});
      });
    };
    document.addEventListener('pointerdown', retry);
    return () => document.removeEventListener('pointerdown', retry);
  }, [v.audioBlocked]);
  if (!streams.length) return null;
  return (
    <>
      {streams.map(s => (
        <PeerAudio
          key={s.id}
          stream={s.stream as unknown as MediaStream}
          sinkId={v.outputDevice}
        />
      ))}
    </>
  );
}
