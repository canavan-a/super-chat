import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import {api} from '../api';
import {
  compareVersions,
  DowngradeBlockedError,
  fetchReleases,
  getVersionInfo,
  onDownloadProgress,
  Release,
  runUpdate,
} from '../appUpdater';
import {exportKeyFile, phraseFromEntropy} from '../crypto';
import {AvatarSource, dataUri, pickAvatarSource, saveTextFileAs} from '../files';
import {AvatarCropper} from '../components/AvatarCropper';
import {Notice} from '../components/Notice';
import {forgetIdentity, loadIdentity, NEEDS_PASSPHRASE} from '../keystore';
import {platformConfirm} from '../platformConfirm';
import {session} from '../session';
import {DEFAULT_SERVER, normalizeServer, settingsStore} from '../settings';
import {getMyAvatar, resetStore, setMyAvatar, useStore} from '../store';
import {THEME_OPTIONS, Theme, useThemeSetting} from '../theme';

type SettingsTab = 'general' | 'account';

const SETTINGS_TABS: {key: SettingsTab; label: string}[] = [
  {key: 'general', label: 'General'},
  {key: 'account', label: 'Account'},
];

const LOCK_OPTIONS = [
  {min: 0, label: 'Immediately'},
  {min: 1, label: '1 min'},
  {min: 5, label: '5 min'},
  {min: 30, label: '30 min'},
];

export function SettingsScreen({onForgotten}: {onForgotten: () => void}): React.JSX.Element {
  const {theme, themeName, setThemeName} = useThemeSetting();
  const styles = makeStyles(theme);
  const [tab, setTab] = useState<SettingsTab>('general');
  const [s, setS] = useState(settingsStore.get());
  useEffect(() => settingsStore.subscribe(setS), []);

  // ---- servers ----
  const [newServer, setNewServer] = useState('');
  const [health, setHealth] = useState<Record<string, boolean | null>>({});
  const testServer = (url: string) => {
    setHealth(h => ({...h, [url]: null}));
    api.health(url).then(ok => setHealth(h => ({...h, [url]: ok})));
  };
  useEffect(() => {
    settingsStore.get().servers.forEach(testServer);
  }, []);
  const addServer = async () => {
    const url = normalizeServer(newServer);
    if (!url) return;
    if (!s.servers.includes(url)) await settingsStore.update({servers: [...s.servers, url]});
    setNewServer('');
    testServer(url);
  };

  // ---- app updates (Android sideload), same flow as super-badger ----
  const [version, setVersion] = useState<string>();
  const [releases, setReleases] = useState<Release[]>([]);
  const [updateStatus, setUpdateStatus] = useState<string>();
  const [updateBusy, setUpdateBusy] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    getVersionInfo()
      .then(v => setVersion(`${v.versionName} (${v.versionCode})`))
      .catch(() => setVersion('unknown'));
    checkForUpdates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!updateBusy) return;
    return onDownloadProgress(({bytesDownloaded, bytesTotal}) => {
      const pct = bytesTotal > 0 ? Math.round((bytesDownloaded / bytesTotal) * 100) : 0;
      setUpdateStatus(`Downloading… ${pct}%`);
    });
  }, [updateBusy]);

  const currentVersionName = version?.split(' ')[0];
  const latestRelease = releases[0];
  const updateAvailable =
    !!latestRelease && !!currentVersionName && compareVersions(latestRelease.version, currentVersionName) > 0;

  const checkForUpdates = async () => {
    setCheckingUpdates(true);
    setUpdateStatus(undefined);
    try {
      setReleases(await fetchReleases());
    } catch (e) {
      setUpdateStatus(`Check failed: ${String(e)}`);
    } finally {
      setCheckingUpdates(false);
    }
  };

  const installUpdate = async () => {
    const target = latestRelease;
    if (!target) return;
    setUpdateBusy(true);
    setUpdateStatus('Starting…');
    try {
      await runUpdate(target);
      setUpdateStatus('Opening installer…');
    } catch (e) {
      if (e instanceof DowngradeBlockedError) {
        Alert.alert('Downgrade blocked', 'Uninstall the app first to install an older version.');
        setUpdateStatus(undefined);
      } else {
        setUpdateStatus(`Update failed: ${String(e)}`);
      }
    } finally {
      setUpdateBusy(false);
    }
  };

  // ---- notifications (Android) ----
  const [bgBusy, setBgBusy] = useState(false);
  const [permStatus, setPermStatus] = useState<string>();
  const toggleBg = async (value: boolean) => {
    setBgBusy(true);
    try {
      const notifee = (await import('@notifee/react-native')).default;
      const {startMonitoring, stopMonitoring} = await import('../service/BackgroundMonitorService');
      if (value) {
        await notifee.requestPermission();
        await startMonitoring();
      } else {
        await stopMonitoring();
      }
      await settingsStore.update({bgNotifications: value});
    } catch (err) {
      Alert.alert('Background notifications', String(err));
    } finally {
      setBgBusy(false);
    }
  };
  const recheckPermission = async () => {
    const notifee = (await import('@notifee/react-native')).default;
    const {AuthorizationStatus} = await import('@notifee/react-native');
    const res = await notifee.requestPermission();
    const ok = res.authorizationStatus === AuthorizationStatus.AUTHORIZED;
    setPermStatus(ok ? 'Allowed' : 'Denied');
    if (!ok) {
      Alert.alert('Notifications denied', 'Enable them in system Settings → Apps → Super Chat → Notifications.', [
        {text: 'Open settings', onPress: () => Linking.openSettings()},
        {text: 'OK', style: 'cancel'},
      ]);
    }
  };
  const sendTest = async () => {
    try {
      const {sendTestNotification} = await import('../notifications/messages');
      await sendTestNotification();
    } catch (err) {
      Alert.alert('Test notification', String(err));
    }
  };

  // ---- account ----
  const me = session.get();
  const [phrase, setPhrase] = useState<string[] | null>(null);
  const [keyPass, setKeyPass] = useState('');
  const [keyStatus, setKeyStatus] = useState<
    {kind: 'working'} | {kind: 'saved'; name: string; location: string} | {kind: 'error'; message: string} | null
  >(null);
  const [keyBusy, setKeyBusy] = useState(false);

  // ---- profile picture ----
  const myAvatar = useStore(getMyAvatar);
  const myAvatarUri = myAvatar ? dataUri('image/jpeg', myAvatar) : null;
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const updateAvatar = async (jpeg: Uint8Array | null) => {
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      await setMyAvatar(jpeg);
    } catch (e) {
      setAvatarError((e as Error).message);
    } finally {
      setAvatarBusy(false);
    }
  };
  // Pick, then frame it in the cropper; it's published once cropped.
  const [cropSrc, setCropSrc] = useState<AvatarSource | null>(null);
  const chooseAvatar = async () => {
    setAvatarError(null);
    try {
      const src = await pickAvatarSource();
      if (src) setCropSrc(src);
    } catch (e) {
      setAvatarError((e as Error).message);
    }
  };
  const [webPass, setWebPass] = useState('');

  // Showing the phrase asks for biometrics (or the passphrase) again: a
  // borrowed, unlocked phone shouldn't be enough to read it off.
  const revealPhrase = async () => {
    try {
      const entropy = await loadIdentity(NEEDS_PASSPHRASE ? webPass : undefined);
      if (entropy) setPhrase(phraseFromEntropy(entropy));
      else if (NEEDS_PASSPHRASE) Alert.alert('Recovery phrase', 'Wrong passphrase.');
    } catch (e) {
      Alert.alert('Recovery phrase', (e as Error).message);
    }
  };

  const saveKeyFile = async () => {
    if (!me) return;
    setKeyBusy(true);
    setKeyStatus({kind: 'working'});
    try {
      const file = await saveTextFileAs('superchat-key.json', () => exportKeyFile(me, keyPass));
      setKeyStatus(file ? {kind: 'saved', ...file} : null);
      if (file) setKeyPass('');
    } catch (e) {
      setKeyStatus({kind: 'error', message: (e as Error).message});
    } finally {
      setKeyBusy(false);
    }
  };

  const forget = () =>
    platformConfirm(
      'Remove account from this device?',
      "Your key is deleted from this device. You can only get back into your rooms with your recovery phrase or key file. Without them, they're gone for good.",
      'Remove',
      async () => {
        await forgetIdentity();
        resetStore();
        session.clear();
        onForgotten();
      },
    );

  return (
    <View style={styles.fill}>
    {cropSrc && (
      <AvatarCropper
        src={cropSrc}
        onCancel={() => setCropSrc(null)}
        onDone={async jpeg => {
          setCropSrc(null);
          await updateAvatar(jpeg);
        }}
      />
    )}
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Settings</Text>

      <View style={styles.tabBar}>
        {SETTINGS_TABS.map(t => (
          <Pressable
            key={t.key}
            style={[styles.tab, tab === t.key && styles.tabActive]}
            onPress={() => setTab(t.key)}
            accessibilityRole="tab"
            accessibilityState={{selected: tab === t.key}}>
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'general' ? (
        <>
          <Text style={styles.title2}>Appearance</Text>
          <View style={styles.themeRow}>
            {THEME_OPTIONS.map(opt => (
              <Pressable
                key={opt.name}
                style={[styles.themeSwatch, themeName === opt.name && styles.themeSwatchActive]}
                onPress={() => setThemeName(opt.name)}>
                <View style={styles.themeSwatchColors}>
                  <View style={[styles.themeSwatchDot, {backgroundColor: THEME_PREVIEW[opt.name].bg}]} />
                  <View style={[styles.themeSwatchDot, {backgroundColor: THEME_PREVIEW[opt.name].primary}]} />
                </View>
                <Text style={styles.themeSwatchLabel}>{opt.label}</Text>
              </Pressable>
            ))}
          </View>

          <View style={[styles.rowBetween, styles.spaced]}>
            <View style={styles.rowBetweenText}>
              <Text style={styles.label}>Launch animation</Text>
              <Text style={styles.hint}>
                The animated logo shown when the app opens. Takes effect next launch.
                {s.splashAutoDisabled
                  ? " It was turned off automatically because it didn't finish on two launches in a row. Turn it back on to try again."
                  : ''}
              </Text>
            </View>
            <Switch
              value={s.launchSplash}
              onValueChange={v => settingsStore.update({launchSplash: v, splashStrikes: 0, splashAutoDisabled: false})}
            />
          </View>

          {Platform.OS === 'android' && (
            <View style={styles.rowBetween}>
              <View style={styles.rowBetweenText}>
                <Text style={styles.label}>Match app icon to theme</Text>
                <Text style={styles.hint}>
                  Changes the launcher icon to the one for your theme when you leave the app. Some launchers take a
                  moment to refresh.
                </Text>
              </View>
              <Switch value={s.themedIcon} onValueChange={v => settingsStore.update({themedIcon: v})} />
            </View>
          )}

          <View style={styles.divider} />
          <Text style={styles.title2}>Servers</Text>
          <Text style={styles.hint}>
            New rooms go on your default server. Joining a room uses the server in its invite link. Anyone can run
            their own server.
          </Text>
          {s.servers.map(url => (
            <View key={url} style={styles.serverRow}>
              <View style={styles.rowBetweenText}>
                <Text style={styles.serverUrl} numberOfLines={1}>
                  {url}
                </Text>
                <Text style={styles.hint}>
                  {health[url] === null ? 'Checking…' : health[url] ? '✓ Reachable' : health[url] === false ? '✗ Unreachable' : ''}
                  {url === s.defaultServer ? ' · default' : ''}
                </Text>
              </View>
              {url !== s.defaultServer && (
                <Pressable style={styles.testButton} onPress={() => settingsStore.update({defaultServer: url})}>
                  <Text style={styles.testButtonText}>Make default</Text>
                </Pressable>
              )}
              {url !== DEFAULT_SERVER && url !== s.defaultServer && (
                <Pressable
                  style={styles.testButton}
                  onPress={() => settingsStore.update({servers: s.servers.filter(x => x !== url)})}>
                  <Text style={styles.testButtonText}>Remove</Text>
                </Pressable>
              )}
            </View>
          ))}
          <View style={styles.serverAdd}>
            <TextInput
              style={[styles.input, styles.flex]}
              value={newServer}
              onChangeText={setNewServer}
              placeholder="https://chat.example.com"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={addServer}
            />
            <Pressable style={styles.testButton} onPress={addServer}>
              <Text style={styles.testButtonText}>Add</Text>
            </Pressable>
          </View>

          {Platform.OS === 'android' && (
            <>
              <View style={styles.divider} />
              <Text style={styles.title2}>App updates</Text>
              <Pressable onPress={checkForUpdates} disabled={checkingUpdates}>
                <Text style={styles.hint}>
                  {checkingUpdates
                    ? 'Checking…'
                    : latestRelease
                      ? updateAvailable
                        ? `Update available: v${latestRelease.version}`
                        : `Up to date (v${latestRelease.version})`
                      : `Current version: ${version ?? '…'}`}
                </Text>
              </Pressable>
              {latestRelease && (
                <Pressable
                  style={[styles.button, styles.spaced, updateBusy && styles.buttonDisabled]}
                  disabled={updateBusy}
                  onPress={installUpdate}>
                  <Text style={styles.buttonText}>
                    {updateBusy ? 'Working…' : updateAvailable ? `Update to v${latestRelease.version}` : 'Reinstall current version'}
                  </Text>
                </Pressable>
              )}
              {updateStatus && <Text style={styles.hint}>{updateStatus}</Text>}

              <View style={styles.divider} />
              <Text style={styles.title2}>Background notifications</Text>
              <View style={styles.rowBetween}>
                <View style={styles.rowBetweenText}>
                  <Text style={styles.label}>Notify on new messages</Text>
                  <Text style={styles.hint}>
                    Keeps an encrypted connection open in the background (with a persistent notification). Messages
                    are decrypted on this phone; nothing passes through Google or any push service.
                  </Text>
                </View>
                <Switch value={s.bgNotifications} onValueChange={toggleBg} disabled={bgBusy} />
              </View>
              <View style={styles.rowBetween}>
                <View style={styles.rowBetweenText}>
                  <Text style={styles.label}>Show message text</Text>
                  <Text style={styles.hint}>Off shows only the room name, so nothing readable sits on the lock screen.</Text>
                </View>
                <Switch value={s.notifPreviews} onValueChange={v => settingsStore.update({notifPreviews: v})} />
              </View>
              <View style={styles.actionStack}>
                <View style={styles.actionRow}>
                  <Pressable style={styles.testButton} onPress={recheckPermission}>
                    <Text style={styles.testButtonText}>Re-check notification permission</Text>
                  </Pressable>
                  {permStatus === 'Allowed' && <Text style={styles.testOk}>✓ {permStatus}</Text>}
                  {permStatus && permStatus !== 'Allowed' && <Text style={styles.testError}>✗ {permStatus}</Text>}
                </View>
                <Pressable style={styles.testButton} onPress={sendTest}>
                  <Text style={styles.testButtonText}>Send test notification</Text>
                </Pressable>
                <Pressable style={styles.testButton} onPress={() => Linking.openSettings()}>
                  <Text style={styles.testButtonText}>Battery optimization settings</Text>
                </Pressable>
              </View>
            </>
          )}
        </>
      ) : (
        <>
          <Text style={styles.title2}>Your account</Text>
          <Text style={styles.hint}>
            Your account never leaves this device, and no server has a record of it. In every room you appear as a
            different, unrelated key, so a server can't tell that two rooms have someone in common. Only your recovery
            phrase ties them together.
          </Text>
          <Text style={[styles.label, styles.spaced]}>This device's account</Text>
          <Text style={styles.mono}>{me?.id.slice(0, 12)}</Text>
          <Text style={styles.hint}>A local fingerprint, to tell accounts apart on this device. It isn't sent anywhere.</Text>

          <Text style={[styles.label, styles.spaced]}>Profile picture</Text>
          <View style={styles.avatarRow}>
            {myAvatarUri ? (
              <Image source={{uri: myAvatarUri}} style={styles.avatarPreview} />
            ) : (
              <View style={[styles.avatarPreview, styles.avatarEmpty]}>
                <Text style={styles.hint}>None</Text>
              </View>
            )}
            <Pressable style={[styles.testButton, avatarBusy && styles.buttonDisabled]} disabled={avatarBusy} onPress={chooseAvatar}>
              {avatarBusy ? <ActivityIndicator size="small" color={theme.text} /> : <Text style={styles.testButtonText}>Choose…</Text>}
            </Pressable>
            {myAvatarUri && !avatarBusy && (
              <Pressable style={styles.testButton} onPress={() => updateAvatar(null)}>
                <Text style={styles.testButtonText}>Remove</Text>
              </Pressable>
            )}
          </View>
          <Text style={styles.hint}>
            Shown in every room you're in. Each room gets its own encrypted copy, so it doesn't link your rooms
            together.
          </Text>
          {avatarError && <Text style={styles.fieldError}>{avatarError}</Text>}

          <View style={styles.field}>
            <Text style={[styles.label, styles.spaced]}>Default display name</Text>
            <TextInput
              style={styles.input}
              value={s.displayName}
              onChangeText={v => settingsStore.update({displayName: v})}
              maxLength={40}
              placeholder="Suggested when you create or join a room"
              placeholderTextColor={theme.textMuted}
            />
          </View>

          {Platform.OS !== 'web' && (
            <>
              <Text style={styles.label}>Lock after</Text>
              <View style={styles.themeRow}>
                {LOCK_OPTIONS.map(o => (
                  <Pressable
                    key={o.min}
                    style={[styles.testButton, s.lockAfterMin === o.min && styles.chipOn]}
                    onPress={() => settingsStore.update({lockAfterMin: o.min})}>
                    <Text style={[styles.testButtonText, s.lockAfterMin === o.min && styles.chipOnText]}>{o.label}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.hint}>How long Super Chat can be in the background before it asks for your fingerprint or PIN.</Text>
            </>
          )}

          <View style={styles.divider} />
          <Text style={styles.title2}>Recovery phrase</Text>
          <Text style={styles.hint}>
            The 24 words that are your account. Anyone who sees them can read your rooms.
          </Text>
          {phrase ? (
            <>
              <Text style={[styles.mono, styles.phrase]} selectable>
                {phrase.map((w, i) => `${i + 1}. ${w}`).join('   ')}
              </Text>
              <Pressable style={[styles.testButton, styles.spaced]} onPress={() => setPhrase(null)}>
                <Text style={styles.testButtonText}>Hide</Text>
              </Pressable>
            </>
          ) : (
            <View style={[styles.serverAdd, styles.spaced]}>
              {NEEDS_PASSPHRASE && (
                <TextInput
                  style={[styles.input, styles.flex]}
                  value={webPass}
                  onChangeText={setWebPass}
                  secureTextEntry
                  placeholder="Passphrase"
                  placeholderTextColor={theme.textMuted}
                />
              )}
              <Pressable style={styles.testButton} onPress={revealPhrase}>
                <Text style={styles.testButtonText}>Show recovery phrase</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.divider} />
          <Text style={styles.title2}>Key file</Text>
          <Text style={styles.hint}>A backup of your key, encrypted with a passphrase you choose.</Text>
          <View style={[styles.serverAdd, styles.spaced]}>
            <TextInput
              style={[styles.input, styles.flex]}
              value={keyPass}
              onChangeText={setKeyPass}
              secureTextEntry
              placeholder="Passphrase (8+ characters)"
              placeholderTextColor={theme.textMuted}
            />
            <Pressable
              style={[styles.testButton, (keyPass.length < 8 || keyBusy) && styles.buttonDisabled]}
              disabled={keyPass.length < 8 || keyBusy}
              onPress={saveKeyFile}>
              {keyBusy ? <ActivityIndicator size="small" color={theme.text} /> : <Text style={styles.testButtonText}>Save key file</Text>}
            </Pressable>
          </View>
          {keyStatus?.kind === 'working' && <Notice kind="working" title="Encrypting and saving… this takes a few seconds." />}
          {keyStatus?.kind === 'saved' && (
            <Notice kind="success" title="Key file saved">
              {keyStatus.name} is in {keyStatus.location}. Move a copy off this phone; it's only useful together with
              its passphrase.
            </Notice>
          )}
          {keyStatus?.kind === 'error' && (
            <Notice kind="error" title="The key file wasn't saved">
              {keyStatus.message}
            </Notice>
          )}

          <View style={styles.divider} />
          <Pressable style={styles.dangerButton} onPress={forget}>
            <Text style={styles.dangerText}>Remove account from this device</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
    </View>
  );
}

// Small fixed swatch colors for the theme picker — deliberately independent
// of `useTheme()` (which only ever reflects the *currently active* theme):
// the picker needs to show all four options' colors at once, including the
// ones not currently selected.
const THEME_PREVIEW: Record<string, {bg: string; primary: string}> = {
  light: {bg: '#ffffff', primary: '#0969da'},
  dark: {bg: '#0d1117', primary: '#2f81f7'},
  slate: {bg: '#1e2530', primary: '#5aa9e6'},
  sepia: {bg: '#f4ecd8', primary: '#a0651b'},
  ember: {bg: '#050403', primary: '#8a3620'},
};

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    fill: {flex: 1},
    scroll: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    container: {
      padding: 20,
      paddingBottom: 48,
      maxWidth: 560,
      width: '100%',
      alignSelf: 'center',
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      marginBottom: 20,
      color: theme.text,
    },
    title2: {
      fontSize: 15,
      fontWeight: '700',
      marginBottom: 10,
      color: theme.text,
    },
    tabBar: {
      flexDirection: 'row',
      gap: 6,
      padding: 4,
      borderRadius: 10,
      backgroundColor: theme.surfaceAlt,
      marginBottom: 20,
    },
    tab: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 8,
      borderRadius: 8,
    },
    tabActive: {
      backgroundColor: theme.surface,
    },
    tabText: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.textMuted,
    },
    tabTextActive: {
      color: theme.text,
    },
    themeRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 10,
    },
    themeSwatch: {
      alignItems: 'center',
      gap: 6,
      padding: 10,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: theme.border,
      backgroundColor: theme.surface,
    },
    themeSwatchActive: {
      borderColor: theme.primary,
    },
    themeSwatchColors: {
      flexDirection: 'row',
      borderRadius: 14,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: theme.border,
    },
    themeSwatchDot: {
      width: 20,
      height: 28,
    },
    themeSwatchLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: theme.text,
    },
    avatarRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6},
    avatarPreview: {width: 56, height: 56, borderRadius: 28},
    avatarEmpty: {alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: theme.border},
    fieldError: {color: theme.danger, fontSize: 12, marginTop: 4},
    buttonDisabled: {
      opacity: 0.5,
    },
    field: {
      marginBottom: 20,
    },
    label: {
      fontSize: 13,
      fontWeight: '600',
      marginBottom: 6,
      color: theme.textMuted,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 15,
      color: theme.text,
      backgroundColor: theme.surface,
    },
    hint: {
      fontSize: 12,
      color: theme.textMuted,
      marginTop: 6,
    },
    testRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: 10,
    },
    // The notification section's buttons: one column, evenly spaced, with a
    // status (e.g. the permission result) allowed beside its button.
    actionStack: {
      gap: 10,
      marginTop: 4,
    },
    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    testButton: {
      alignSelf: 'flex-start',
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 6,
      backgroundColor: theme.surfaceAlt,
    },
    testButtonText: {
      fontWeight: '600',
      fontSize: 13,
      color: theme.text,
    },
    testOk: {
      color: theme.success,
      fontSize: 13,
    },
    testError: {
      color: theme.danger,
      fontSize: 13,
      flexShrink: 1,
    },
    button: {
      backgroundColor: theme.primary,
      borderRadius: 8,
      paddingVertical: 12,
      alignItems: 'center',
    },
    buttonText: {
      color: theme.primaryText,
      fontWeight: '600',
    },
    divider: {
      height: 1,
      backgroundColor: theme.border,
      marginVertical: 24,
    },
    rowBetween: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 12,
    },
    rowBetweenText: {
      flex: 1,
      minWidth: 0,
      gap: 4,
    },
    spaced: {
      marginTop: 14,
    },
    flex: {
      flex: 1,
      minWidth: 0,
    },
    serverRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    serverUrl: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.text,
    },
    serverAdd: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 10,
    },
    mono: {
      fontFamily: 'monospace',
      fontSize: 13,
      color: theme.text,
    },
    phrase: {
      marginTop: 10,
      lineHeight: 22,
      padding: 10,
      borderRadius: 6,
      backgroundColor: theme.surface,
    },
    chipOn: {
      backgroundColor: theme.primary,
    },
    chipOnText: {
      color: theme.primaryText,
    },
    dangerButton: {
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: theme.dangerBg,
      alignItems: 'center',
    },
    dangerText: {
      color: theme.danger,
      fontWeight: '700',
    },
  });
}
