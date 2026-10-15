// On Android, react-native-webrtc plays remote audio by itself; the web
// build renders <audio> elements instead (RemoteAudio.web.tsx).
export function RemoteAudio(): null {
  return null;
}
