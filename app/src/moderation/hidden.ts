// Messages hidden with "Hide message" (long-press, iOS): gone from this
// device's view of the room straight away. Nothing is sent: the message stays
// on the server and for everyone else. Kept per room, on this device only.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useEffect, useState} from 'react';

const STORAGE_KEY = 'superchat.hidden.v1';
const NONE: ReadonlySet<string> = new Set();

let hidden: Record<string, Set<string>> = {};
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  loading ??= AsyncStorage.getItem(STORAGE_KEY)
    .then(raw => {
      const saved: Record<string, string[]> = raw ? JSON.parse(raw) : {};
      for (const [room, ids] of Object.entries(saved)) hidden[room] = new Set([...ids, ...(hidden[room] ?? [])]);
    })
    .catch(() => {})
    .then(() => listeners.forEach(l => l()));
  return loading;
}

export async function hideMessage(roomKey: string, msgId: string): Promise<void> {
  hidden = {...hidden, [roomKey]: new Set([...(hidden[roomKey] ?? []), msgId])};
  listeners.forEach(l => l());
  await load();
  const out = Object.fromEntries(Object.entries(hidden).map(([room, ids]) => [room, [...ids]]));
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(out)).catch(() => {});
}

/** The ids of a room's hidden messages. */
export function useHidden(roomKey: string): ReadonlySet<string> {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender(n => n + 1);
    listeners.add(l);
    load();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return hidden[roomKey] ?? NONE;
}
