// The unlocked account, held in memory only. It lives as long as the app's
// process: the background notification service runs in the same process and
// needs it to sign in to servers. The app lock (see App.tsx) gates the UI;
// it doesn't throw the keys away.
import {Identity, identityFromEntropy} from './crypto';

type Listener = (me: Identity | null) => void;

let me: Identity | null = null;
const listeners = new Set<Listener>();

export const session = {
  get: (): Identity | null => me,
  require(): Identity {
    if (!me) throw new Error('locked');
    return me;
  },
  unlock(entropy: Uint8Array): Identity {
    me = identityFromEntropy(entropy);
    listeners.forEach(l => l(me));
    return me;
  },
  /** Forget the keys entirely (sign out / forget this device). */
  clear(): void {
    me = null;
    listeners.forEach(l => l(null));
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
