// Bridges a notification tap into App.tsx's navigation when the app was
// alive-but-backgrounded at tap time: notifee delivers that case via
// index.js's onBackgroundEvent, which has no React tree to navigate from.
// In-memory only; the killed-app case goes through
// notifee.getInitialNotification() in App.tsx.
type Listener = (roomKey: string) => void;

let pending: string | null = null;
const listeners = new Set<Listener>();

export const pendingNav = {
  get: (): string | null => pending,
  set(roomKey: string): void {
    pending = roomKey;
    listeners.forEach(l => l(roomKey));
  },
  clear(): void {
    pending = null;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Stands in for a room key when a tap should open Settings (the update notification). */
export const SETTINGS_NAV = '#settings';

/** Where a tapped notification should go: its room, or SETTINGS_NAV. */
export function navTarget(data: Record<string, unknown> | undefined): string | null {
  const t = data?.nav ?? data?.roomKey;
  return typeof t === 'string' ? t : null;
}
