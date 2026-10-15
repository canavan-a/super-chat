import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  AppStateStatus,
  BackHandler,
  Dimensions,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {useThemedAppIcon} from './appIcon';
import {handleVoiceAction} from './call/voiceService';
import {RemoteAudio} from './call/RemoteAudio';
import {voice} from './call/voice';
import {applyUpdateIfSafe, setThemeColor, startPwa} from './pwa/pwa';
import {ChatAvatar} from './components/ChatAvatar';
import {CrashScreen} from './components/CrashScreen';
import {isSideload} from './distribution';
import {PortalOutlet, PortalProvider} from './components/Portal';
import {PixelField} from './components/PixelField';
import {Icon, IconName} from './components/Icon';
import {AvatarRef, parseInviteLink} from './crypto';
import {hasStoredIdentity, NEEDS_PASSPHRASE} from './keystore';
import {LogoLine} from './logo/LogoArt';
import {SplashGate} from './logo/SplashGate';
import {splashHold} from './logo/splashHold';
import {navTarget, pendingNav, SETTINGS_NAV} from './notifications/pendingNav';
import {Route} from './routes';
import {LockScreen} from './screens/LockScreen';
import {JoinScreen, NewRoomScreen} from './screens/NewRoomScreen';
import {RoomListScreen} from './screens/RoomListScreen';
import {OnboardingScreen} from './screens/OnboardingScreen';
import {RoomScreen} from './screens/RoomScreen';
import {RoomSettingsScreen} from './screens/RoomSettingsScreen';
import {SettingsScreen} from './screens/SettingsScreen';
import {VoiceScreen} from './screens/VoiceScreen';
import {VoiceBar} from './components/VoiceBar';
import {session} from './session';
import {settingsStore} from './settings';
import {getRoom, isServerOnline, refreshRooms, resetStore, roomList, roomsReady, useStore} from './store';
import {Theme, ThemeProvider, useTheme} from './theme';

const TITLES: Record<Route['name'], string> = {
  home: 'Super Chat',
  room: 'Room',
  roomSettings: 'Room settings',
  newRoom: 'New chat',
  join: 'Join a room',
  settings: 'Settings',
  voice: 'Voice',
};

// Screens report their own title/subtitle/actions up here so they render in
// the one top bar, the same arrangement as super-badger's station header.
export interface HeaderInfo {
  title: string;
  // The room's chosen color, drawn as a left-edge stripe on the header bar,
  // matching the drawer row's left border.
  accentColor?: string;
  subtitle?: string;
  /** The chat's picture (or color disc), shown beside the title. */
  avatar?: {roomKey: string; picture: AvatarRef | null; color: string};
  actions?: {label: string; onPress: () => void; destructive?: boolean; icon?: IconName}[];
  /** Tapping the title area (a room's header opens its controls). */
  onPress?: () => void;
}

type Gate = 'loading' | 'onboard' | 'locked' | 'ready';

/**
 * Decides what's on screen before any room is: onboarding (no key on this
 * device), the lock screen (key present, not unlocked or locked again after
 * time in the background), or the app itself.
 */
function AccountGate(): React.JSX.Element {
  const theme = useTheme();
  const [gate, setGate] = useState<Gate>('loading');
  const backgroundedAt = useRef<number | null>(null);

  // The launch splash doubles as the loading screen: hold it until there's
  // something to show (see splashHold). Onboarding, and a lock screen that
  // needs typing, show at once; a biometric unlock's prompt draws over the
  // splash, and the room list lets go once the rooms are in.
  useEffect(() => {
    splashHold.hold();
    hasStoredIdentity().then(has => setGate(has ? (session.get() ? 'ready' : 'locked') : 'onboard'));
  }, []);
  useEffect(() => {
    if (gate === 'onboard' || (gate === 'locked' && NEEDS_PASSPHRASE)) splashHold.release();
  }, [gate]);

  // Re-lock after time in the background. This gates the UI only; the keys
  // stay in memory so background notifications keep working.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background') {
        backgroundedAt.current = Date.now();
      } else if (state === 'active' && backgroundedAt.current !== null) {
        const away = Date.now() - backgroundedAt.current;
        backgroundedAt.current = null;
        if (session.get() && away >= settingsStore.get().lockAfterMin * 60_000) {
          setGate(g => (g === 'ready' ? 'locked' : g));
        }
      }
    });
    return () => sub.remove();
  }, []);

  const unlocked = useCallback((entropy: Uint8Array) => {
    session.unlock(entropy);
    setGate('ready');
    refreshRooms().catch(() => {});
  }, []);

  if (gate === 'loading') {
    return (
      <View style={[styles.fill, {backgroundColor: theme.bg}]}>
        <ActivityIndicator color={theme.textMuted} />
      </View>
    );
  }
  if (gate === 'onboard') return <OnboardingScreen onDone={unlocked} />;
  if (gate === 'locked') {
    return (
      <LockScreen
        onUnlock={unlocked}
        onForget={() => {
          resetStore();
          session.clear();
          setGate('onboard');
        }}
      />
    );
  }
  return (
    <AppInner
      onForgotten={() => {
        setGate('onboard');
      }}
    />
  );
}

function AppInner({onForgotten}: {onForgotten: () => void}): React.JSX.Element {
  const theme = useTheme();
  useThemedAppIcon();
  const styles = makeStyles(theme);
  const rooms = useStore(roomList);
  const ready = useStore(roomsReady);
  useEffect(() => {
    if (ready) splashHold.release();
  }, [ready]);
  // The app opens on the room list ('home'); every other screen backs out
  // to it (room settings backs out to its room first).
  const [route, setRoute] = useState<Route>({name: 'home'});
  const [headerInfo, setHeaderInfo] = useState<HeaderInfo | null>(null);

  const navigate = useCallback((next: Route) => {
    if (next.name !== 'room' && next.name !== 'roomSettings' && next.name !== 'voice') setHeaderInfo(null);
    if (next.name === 'room') settingsStore.update({lastRoom: next.key});
    setRoute(next);
  }, []);

  const goBack = useCallback(() => {
    if (route.name === 'roomSettings' || route.name === 'voice') navigate({name: 'room', key: route.key});
    else navigate({name: 'home'});
  }, [route, navigate]);

  // If the open room disappears (kicked, left elsewhere), go home.
  useEffect(() => {
    if ((route.name === 'room' || route.name === 'roomSettings' || route.name === 'voice') && ready && !getRoom(route.key)) {
      navigate({name: 'home'});
    }
  }, [rooms, route, ready, navigate]);

  // Invite links: opened from outside (superchat:// or https://…/i/…).
  useEffect(() => {
    const handle = (url: string | null) => {
      if (url && parseInviteLink(url)) navigate({name: 'join', link: url});
    };
    Linking.getInitialURL().then(handle).catch(() => {});
    const sub = Linking.addEventListener('url', e => handle(e.url));
    return () => sub.remove();
  }, [navigate]);

  // Background notifications: resume on unlock if they were on. The service
  // also notifies while the app is open, for rooms other than the one on
  // screen.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!isSideload) {
      // Google Play build: no background service. Notify while the app runs,
      // and get woken through FCM when it doesn't (src/push.ts).
      import('./service/BackgroundMonitorService').then(({watchWhileOpen}) => watchWhileOpen());
      import('./push').then(({startPush}) => startPush().catch(() => {}));
    } else if (settingsStore.get().bgNotifications) {
      import('./service/BackgroundMonitorService').then(({startMonitoring}) => startMonitoring().catch(() => {}));
    }
  }, []);

  // Every launch: ask for notifications if they're off, then look for a new
  // version (which posts the sticky update notification). The update check
  // repeats on each return to the foreground; it throttles itself.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const updates = import('./notifications/updates');
    updates.then(async ({nagForPermission, checkForUpdate}) => {
      await nagForPermission();
      // The Google Play build is updated by Play, never by the app.
      if (isSideload) await checkForUpdate({force: true});
    });
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active' && isSideload) updates.then(({checkForUpdate}) => checkForUpdate());
    });
    return () => sub.remove();
  }, []);

  // Notification tap → open that room (or Settings, for the update
  // notification), from any app state (see index.js).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let unsubscribeForeground: (() => void) | undefined;
    const open = (target: string | null) => {
      if (target === SETTINGS_NAV) navigate({name: 'settings'});
      else if (target) navigate({name: 'room', key: target});
    };
    import('@notifee/react-native').then(({default: notifee, EventType}) => {
      notifee.getInitialNotification().then(initial => open(navTarget(initial?.notification.data)));
      unsubscribeForeground = notifee.onForegroundEvent(({type, detail}) => {
        if (type === EventType.ACTION_PRESS && handleVoiceAction(detail.pressAction?.id)) return;
        if (type === EventType.PRESS) open(navTarget(detail.notification?.data));
      });
    });
    const unsubscribePending = pendingNav.subscribe(key => {
      pendingNav.clear();
      open(key);
    });
    const already = pendingNav.get();
    if (already !== null) {
      pendingNav.clear();
      open(already);
    }
    return () => {
      unsubscribeForeground?.();
      unsubscribePending();
    };
  }, [navigate]);

  // Tell the notification side which room is on screen.
  const viewingKey = route.name === 'room' ? route.key : null;
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const report = (state: AppStateStatus) => {
      const key = state === 'active' ? viewingKey : null;
      import('./notifications/messages')
        .then(({setViewingRoom, clearUnread}) => {
          setViewingRoom(key);
          if (key) clearUnread(key);
        })
        .catch(() => {});
    };
    report(AppState.currentState);
    const sub = AppState.addEventListener('change', report);
    return () => sub.remove();
  }, [viewingKey]);

  // Android back does what the header's back arrow does; on the list it
  // leaves the app.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'home') return false;
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [route, goBack]);

  // Two swipes in a room. Finger to the right, anywhere: the chat slides off
  // with it, the room list showing underneath, and past a third of the
  // screen (or flicked) it goes back to the list. Finger to the left from
  // the right edge: the previous room, like super-badger's station cycling.
  const screenWidth = Dimensions.get('window').width;
  const swipeX = useRef(new Animated.Value(0)).current;
  const swipeAnimating = useRef(false);
  const swipeMode = useRef<'back' | 'prev' | null>(null);
  const [peekList, setPeekList] = useState(false);
  const EDGE_ZONE = 28;
  const SWIPE_THRESHOLD = 70;
  const currentIndex = route.name === 'room' ? rooms.findIndex(r => r.key === route.key) : -1;
  const inRoom = route.name === 'room';
  const canSwipe = inRoom && currentIndex >= 0 && rooms.length > 1;
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: evt =>
          canSwipe && !swipeAnimating.current && evt.nativeEvent.pageX > screenWidth - EDGE_ZONE,
        // Capture, so a clearly sideways drag wins over the chat's own
        // (vertical) scrolling and the message rows.
        onMoveShouldSetPanResponderCapture: (evt, g) => {
          if (!inRoom || swipeAnimating.current) return false;
          if (g.dx > 14 && g.dx > Math.abs(g.dy) * 2.5) {
            swipeMode.current = 'back';
            setPeekList(true);
            return true;
          }
          if (canSwipe && evt.nativeEvent.pageX > screenWidth - EDGE_ZONE && g.dx < -5 && Math.abs(g.dx) > Math.abs(g.dy) * 2) {
            swipeMode.current = 'prev';
            return true;
          }
          return false;
        },
        onPanResponderMove: (_e, g) =>
          swipeX.setValue(swipeMode.current === 'back' ? Math.max(0, g.dx) : Math.min(0, g.dx)),
        onPanResponderRelease: (_e, g) => {
          if (swipeMode.current === 'back') {
            swipeMode.current = null;
            if (g.dx > screenWidth / 3 || g.vx > 0.6) {
              swipeAnimating.current = true;
              Animated.timing(swipeX, {toValue: screenWidth, duration: 160, useNativeDriver: true}).start(() => {
                navigate({name: 'home'});
                swipeX.setValue(0);
                setPeekList(false);
                swipeAnimating.current = false;
              });
            } else {
              Animated.spring(swipeX, {toValue: 0, useNativeDriver: true, bounciness: 4}).start(() => setPeekList(false));
            }
            return;
          }
          swipeMode.current = null;
          if (g.dx < -SWIPE_THRESHOLD) {
            swipeAnimating.current = true;
            Animated.timing(swipeX, {toValue: -screenWidth, duration: 180, useNativeDriver: true}).start(({finished}) => {
              if (!finished) {
                swipeAnimating.current = false;
                return;
              }
              const prev = (currentIndex - 1 + rooms.length) % rooms.length;
              navigate({name: 'room', key: rooms[prev].key});
              swipeX.setValue(screenWidth);
              Animated.timing(swipeX, {toValue: 0, duration: 220, useNativeDriver: true}).start(() => {
                swipeAnimating.current = false;
              });
            });
          } else {
            Animated.spring(swipeX, {toValue: 0, useNativeDriver: true, bounciness: 6}).start();
          }
        },
        onPanResponderTerminate: () => {
          swipeMode.current = null;
          Animated.spring(swipeX, {toValue: 0, useNativeDriver: true}).start(() => setPeekList(false));
        },
        onPanResponderTerminationRequest: () => false,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inRoom, canSwipe, currentIndex, rooms, screenWidth],
  );

  const showingRoomHeader = (route.name === 'room' || route.name === 'roomSettings' || route.name === 'voice') && headerInfo;
  const activeKey = route.name === 'room' || route.name === 'roomSettings' || route.name === 'voice' ? route.key : null;
  const offline = activeKey ? !isServerOnline(getRoom(activeKey)?.server ?? '') : false;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle={theme.name === 'light' || theme.name === 'sepia' ? 'dark-content' : 'light-content'} />

      {offline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>Can't reach this room's server. Reconnecting…</Text>
        </View>
      )}

      <View
        style={[
          styles.header,
          showingRoomHeader && headerInfo!.accentColor ? {borderLeftWidth: 4, borderLeftColor: headerInfo!.accentColor} : null,
        ]}>
        {/* The constellation carries on up through the header. */}
        <PixelField />
        {route.name !== 'home' && (
          <Pressable style={styles.headerBack} onPress={goBack} accessibilityLabel="Back" hitSlop={8}>
            <Icon name="chevron-left" size={22} color={theme.text} />
          </Pressable>
        )}
        {showingRoomHeader && headerInfo!.avatar ? (
          <View style={styles.headerAvatar}>
            <ChatAvatar {...headerInfo!.avatar} size={32} />
          </View>
        ) : null}
        <Pressable
          style={({pressed}) => [styles.headerTextArea, pressed && showingRoomHeader && headerInfo!.onPress && styles.headerPressed]}
          disabled={!(showingRoomHeader && headerInfo!.onPress)}
          onPress={() => headerInfo?.onPress?.()}
          accessibilityRole={showingRoomHeader && headerInfo!.onPress ? 'button' : undefined}
          accessibilityHint={showingRoomHeader && headerInfo!.onPress ? 'Opens the room controls' : undefined}>
          {route.name === 'home' ? (
            // The app's own lettering, on one line, rather than plain text.
            <LogoLine height={22} />
          ) : (
            <View style={styles.headerTitleRow}>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {showingRoomHeader ? headerInfo!.title : TITLES[route.name]}
              </Text>
              {showingRoomHeader && headerInfo!.onPress ? <Icon name="chevron-right" size={16} color={theme.textMuted} /> : null}
            </View>
          )}
          {showingRoomHeader && headerInfo!.subtitle ? (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {headerInfo!.subtitle}
            </Text>
          ) : null}
        </Pressable>
        {showingRoomHeader && headerInfo!.actions ? (
          <View style={styles.headerActions}>
            {headerInfo!.actions.map(a =>
              a.icon ? (
                <Pressable key={a.label} style={styles.headerIconButton} onPress={a.onPress} accessibilityLabel={a.label}>
                  <Icon name={a.icon} size={19} color={theme.text} />
                </Pressable>
              ) : (
                <Pressable key={a.label} style={styles.headerActionButton} onPress={a.onPress}>
                  <Text style={[styles.headerActionText, a.destructive && styles.headerActionDestructive]}>{a.label}</Text>
                </Pressable>
              ),
            )}
          </View>
        ) : null}
        {route.name === 'home' && (
          <Pressable style={styles.headerIconButton} onPress={() => navigate({name: 'settings'})} accessibilityLabel="Settings">
            <Icon name="gear" size={20} color={theme.text} />
          </Pressable>
        )}
      </View>

      {route.name !== 'voice' && <VoiceBar navigate={navigate} />}
      <RemoteAudio />

      <View style={styles.bodyArea}>
        {peekList && (
          // The list the back-swipe returns to, revealed as the chat slides off.
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <RoomListScreen rooms={rooms} loading={!ready} onNavigate={navigate} />
          </View>
        )}
        <Animated.View
          style={[styles.body, peekList && styles.bodyLifted, {transform: [{translateX: swipeX}]}]}
          {...panResponder.panHandlers}>
          {route.name === 'home' && <RoomListScreen rooms={rooms} loading={!ready} onNavigate={navigate} />}
          {route.name === 'room' && (
            // Keyed so switching rooms fully remounts the chat.
            <RoomScreen key={route.key} roomKey={route.key} onNavigate={navigate} onHeaderChange={setHeaderInfo} />
          )}
          {route.name === 'roomSettings' && (
            <RoomSettingsScreen key={route.key} roomKey={route.key} onNavigate={navigate} onHeaderChange={setHeaderInfo} />
          )}
          {route.name === 'newRoom' && <NewRoomScreen onNavigate={navigate} />}
          {route.name === 'join' && <JoinScreen key={route.link ?? ''} link={route.link} onNavigate={navigate} />}
          {route.name === 'settings' && <SettingsScreen onForgotten={onForgotten} />}
          {route.name === 'voice' && (
            <VoiceScreen key={route.key} roomKey={route.key} onNavigate={navigate} onHeaderChange={setHeaderInfo} />
          )}
        </Animated.View>
      </View>
      {/* Modal sheets (Overlay modal), over everything. */}
      <PortalOutlet />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: {flex: 1, alignItems: 'center', justifyContent: 'center'},
});

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    offlineBanner: {
      backgroundColor: theme.dangerBg,
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme.danger,
    },
    offlineBannerText: {color: theme.danger, fontSize: 12, fontWeight: '600', textAlign: 'center'},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    headerBack: {width: 36, height: 36, alignItems: 'center', justifyContent: 'center', marginRight: 4, marginLeft: -6},
    headerAvatar: {marginRight: 10},
    headerTextArea: {flex: 1, minWidth: 0, borderRadius: 6},
    headerPressed: {opacity: 0.6},
    headerTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 2},
    headerTitle: {fontSize: 16, fontWeight: '700', color: theme.text, flexShrink: 1},
    headerSubtitle: {fontSize: 11, color: theme.textMuted, marginTop: 1},
    headerActions: {flexDirection: 'row', gap: 6},
    headerActionButton: {paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.surfaceAlt},
    headerActionText: {fontSize: 12, fontWeight: '600', color: theme.text},
    headerActionDestructive: {color: theme.danger},
    headerIconButton: {width: 32, height: 32, alignItems: 'center', justifyContent: 'center'},
    bodyArea: {flex: 1},
    body: {flex: 1, backgroundColor: theme.bg},
    // While a back-swipe shows the list underneath: a soft edge shadow.
    bodyLifted: {
      elevation: 12,
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 10,
      shadowOffset: {width: -4, height: 0},
    },
  });
}

// Web: the installable app's service worker and update policy (src/pwa).
// A new version only switches in (a reload) when nothing is lost: the app
// is locked and not in voice, and either it just launched or it's hidden.
const launchedAt = Date.now();
startPwa(
  () =>
    !!session.get() ||
    voice.active() ||
    (typeof document !== 'undefined' && document.visibilityState === 'visible' && Date.now() - launchedAt > 8000),
);
session.subscribe(me => {
  if (!me) applyUpdateIfSafe();
});

/** Keeps the browser's status bar / title bar in the theme's background (web). */
function ThemeChrome(): null {
  const theme = useTheme();
  useEffect(() => setThemeColor(theme.bg), [theme.bg]);
  return null;
}

function App(): React.JSX.Element {
  return (
    <CrashScreen>
      <ThemeProvider>
        <ThemeChrome />
        <PortalProvider>
          <SplashGate>
            <AccountGate />
          </SplashGate>
        </PortalProvider>
      </ThemeProvider>
    </CrashScreen>
  );
}

export default App;
