import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Pressable, ScrollView, Text, View} from 'react-native';

import {Icon} from '../components/Icon';
import {loadIdentity, NEEDS_PASSPHRASE} from '../keystore';
import {splashHold} from '../logo/splashHold';
import {LogoArt} from '../logo/LogoArt';
import {useTheme} from '../theme';
import {makeStyles, PassphraseForm} from './OnboardingScreen';

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

  const unlock = useCallback(
    async (pass?: string) => {
      setBusy(true);
      setError(null);
      try {
        const entropy = await loadIdentity(pass);
        if (entropy) {
          onUnlock(entropy);
          return;
        }
        if (!NEEDS_PASSPHRASE) setError('Unlock cancelled.');
        // The lock screen has something to say: stop showing the splash over it.
        splashHold.release();
      } catch (e) {
        splashHold.release();
        setError((e as Error).message || 'Could not unlock.');
      } finally {
        setBusy(false);
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
        <View style={styles.center}>
          <Icon name="lock" size={28} color={theme.textMuted} />
          <Text style={styles.body}>Super Chat is locked.</Text>
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
