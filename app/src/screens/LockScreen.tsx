import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import {Icon} from '../components/Icon';
import {loadIdentity, NEEDS_PASSPHRASE} from '../keystore';
import {splashHold} from '../logo/splashHold';
import {LogoArt} from '../logo/LogoArt';
import {useTheme} from '../theme';
import {makeStyles, PassphraseForm} from './OnboardingScreen';

/** Longest a fingerprint/PIN unlock may take before the screen gives up on it. */
const UNLOCK_TIMEOUT_MS = 45_000;

/** Keystore failures arrive as Java exception text; say something a person can act on. */
function friendlyError(e: Error): string {
  const m = e.message || '';
  if (/cancel/i.test(m)) return 'Unlock cancelled.';
  if (/javax|keystore|wrapped|cipher/i.test(m)) return "Couldn't unlock with your fingerprint or PIN. Tap Unlock to try again.";
  return m || 'Could not unlock.';
}

/**
 * Shown when the key is stored but not unlocked. On Android it asks for
 * biometrics or the screen-lock PIN straight away; in a browser it asks for
 * the passphrase.
 */
export function LockScreen({
  onUnlock,
  onForget,
}: {
  onUnlock: (entropy: Uint8Array) => void;
  onForget: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Each attempt's number: a late answer from an attempt that already timed
  // out may still unlock, but mustn't overwrite a newer attempt's state.
  const attempt = useRef(0);
  const unlock = useCallback(
    async (pass?: string) => {
      const mine = ++attempt.current;
      setBusy(true);
      setError(null);
      // The Keystore call has been seen to never answer; don't leave the
      // buttons disabled forever waiting for it.
      const timer = setTimeout(() => {
        if (attempt.current !== mine) return;
        attempt.current++;
        splashHold.release();
        setBusy(false);
        setError("Unlock didn't respond. Tap Unlock to try again.");
      }, UNLOCK_TIMEOUT_MS);
      try {
        const entropy = await loadIdentity(pass);
        if (entropy) {
          onUnlock(entropy);
          return;
        }
        if (attempt.current !== mine) return;
        if (!NEEDS_PASSPHRASE) setError('Unlock cancelled.');
        // The lock screen has something to say: stop showing the splash over it.
        splashHold.release();
      } catch (e) {
        if (attempt.current !== mine) return;
        splashHold.release();
        setError(friendlyError(e as Error));
      } finally {
        clearTimeout(timer);
        if (attempt.current === mine) setBusy(false);
      }
    },
    [onUnlock],
  );

  useEffect(() => {
    if (!NEEDS_PASSPHRASE) unlock();
  }, [unlock]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.center}>
        <LogoArt height={190} />
      </View>
      {NEEDS_PASSPHRASE ? (
        <PassphraseForm
          title="Locked"
          hint="Enter the passphrase that protects your key in this browser."
          confirm={false}
          styles={styles}
          theme={theme}
          busy={busy}
          onOk={unlock}
        />
      ) : (
        // Clear air between the wordmark and the lock, and no caption: the
        // lock and the button say it.
        <View style={[styles.center, local.lockArea]}>
          <Icon name="lock" size={28} color={theme.textMuted} />
          <Pressable style={styles.primary} onPress={() => unlock()} disabled={busy}>
            <Text style={styles.primaryText}>Unlock</Text>
          </Pressable>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable style={styles.secondary} onPress={onForget}>
        <Text style={styles.secondaryText}>Use a different account…</Text>
      </Pressable>
    </ScrollView>
  );
}

const local = StyleSheet.create({
  lockArea: {marginTop: 40, gap: 16},
});
