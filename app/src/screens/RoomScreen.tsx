import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  Clipboard,
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type {HeaderInfo} from '../App';
import {FileRef, fingerprint} from '../crypto';
import {pickFiles, pickImages, PickedFile, saveFileAs} from '../files';
import {openVoice} from '../call/actions';
import {Avatar} from '../components/Avatar';
import {PixelField} from '../components/PixelField';
import {Icon} from '../components/Icon';
import {ImageViewer} from '../components/ImageViewer';
import {Overlay} from '../components/Overlay';
import {MarkdownText} from '../components/Markdown';
import {TypingDots} from '../components/TypingDots';
import {VoiceStrip} from '../components/VoiceStrip';
import {tick} from '../haptics';
import {platformConfirm} from '../platformConfirm';
import {QUICK_REACTIONS, settingsStore} from '../settings';
import {Route} from '../routes';
import {
  chatPicture,
  chatTitle,
  ChatMessage,
  deleteMessage,
  fetchFile,
  getRoom,
  loadImage,
  loadOlder,
  markRead,
  openRoom,
  peekImage,
  react,
  unreact,
  Room,
  roomsReady,
  send,
  sendFiles,
  sendTyping,
  ShownImage,
  useStore,
} from '../store';
import {Theme, useTheme} from '../theme';


type Styles = ReturnType<typeof makeStyles>;

export function RoomScreen({
  roomKey,
  onNavigate,
  onHeaderChange,
}: {
  roomKey: string;
  onNavigate: (route: Route) => void;
  onHeaderChange: (info: HeaderInfo | null) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const room = useStore(() => getRoom(roomKey));
  const ready = useStore(roomsReady);
  const meId = room?.me.id ?? '';
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [sending, setSending] = useState(false);
  /** What an attachment upload is doing, shown above the composer. */
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    openRoom(roomKey);
  }, [roomKey]);

  const view = room?.view;
  const isAdmin = !!view?.members.find(m => m.id === meId && m.role === 'admin');
  const nameOf = useCallback((id: string) => view?.names[id] ?? fingerprint(id), [view]);

  useEffect(() => {
    if (!view) return;
    onHeaderChange({
      title: chatTitle(room) ?? 'Encrypted chat',
      accentColor: view.color ?? undefined,
      avatar: {roomKey, picture: chatPicture(room), color: view.color ?? theme.surfaceAlt},
      subtitle: `${view.members.length} member${view.members.length === 1 ? '' : 's'} · end-to-end encrypted${
        view.retentionDays ? ` · ${view.retentionDays}d` : ''
      }`,
      // Tapping the header opens the room's controls (members, invites, settings).
      onPress: () => onNavigate({name: 'roomSettings', key: roomKey}),
      actions: [{label: 'Voice', icon: 'headphones', onPress: () => openVoice(roomKey, onNavigate)}],
    });
  }, [view, room, theme, roomKey, onHeaderChange, onNavigate]);

  // Read receipts: the newest message counts as read while this room is on
  // screen and the app is in the foreground.
  const lastPos = room?.lastPos ?? 0;
  useEffect(() => {
    if (AppState.currentState === 'active' && room?.loaded) markRead(roomKey);
    const sub = AppState.addEventListener('change', s => s === 'active' && markRead(roomKey));
    return () => sub.remove();
  }, [roomKey, lastPos, room?.loaded]);

  if (!room) {
    return (
      <View style={styles.center}>
        {ready ? <Text style={styles.muted}>This room is gone.</Text> : <ActivityIndicator color={theme.textMuted} />}
      </View>
    );
  }

  const doSend = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    const reply = replyTo?.id;
    setReplyTo(null);
    try {
      await send(roomKey, {t: 'text', body, replyTo: reply});
      setError(null);
    } catch (e) {
      setDraft(body);
      setError((e as Error).message);
    }
  };

  const doAttach = async (kind: 'image' | 'file') => {
    setAttachOpen(false);
    let files: PickedFile[] = [];
    try {
      files = kind === 'image' ? await pickImages() : await pickFiles();
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (!files.length) return;
    const tooBig = files.find(f => f.data.length > 24 * 1024 * 1024);
    if (tooBig) {
      setError(`${tooBig.name} is over 24 MB.`);
      return;
    }
    // The caption and reply go with the files; clear them now so the composer
    // is free while the upload runs (and put them back if it fails).
    const caption = draft.trim();
    const reply = replyTo;
    setDraft('');
    setReplyTo(null);
    setSending(true);
    try {
      await sendFiles(roomKey, files, caption, reply?.id, setUploadStatus);
      setError(null);
    } catch (e) {
      setDraft(d => d || caption);
      setReplyTo(r => r ?? reply);
      setError(`Couldn't send: ${(e as Error).message}`);
    } finally {
      setSending(false);
      setUploadStatus(null);
    }
  };

  const onChangeDraft = (t: string) => {
    setDraft(t);
    if (t && Date.now() - lastTyping.current > 3000) {
      lastTyping.current = Date.now();
      sendTyping(roomKey);
    }
  };

  const typing = Object.entries(room.typing)
    .filter(([, until]) => until > Date.now())
    .map(([id]) => nameOf(id));

  return (
    <View style={styles.container}>
      <VoiceStrip roomKey={roomKey} onNavigate={onNavigate} />
      {(room.error || error) && (
        <View style={styles.errorRow}>
          <Text style={styles.errorText}>{error ?? room.error}</Text>
          <Pressable onPress={() => setError(null)} hitSlop={8}>
            <Icon name="close" size={14} color={theme.danger} />
          </Pressable>
        </View>
      )}

      {!room.loaded && room.messages.length === 0 ? (
        <View style={styles.center}>
          {room.error && !room.loading ? (
            <>
              <Text style={styles.muted}>Couldn't load this room.</Text>
              <Pressable style={styles.retryButton} onPress={() => openRoom(roomKey)}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </>
          ) : (
            <>
              <ActivityIndicator color={theme.textMuted} />
              <Text style={styles.muted}>Decrypting messages…</Text>
            </>
          )}
        </View>
      ) : (
        <ChatList
          room={room}
          meId={meId}
          isAdmin={isAdmin}
          nameOf={nameOf}
          styles={styles}
          theme={theme}
          onReply={m => setReplyTo(m)}
        />
      )}

      {typing.length > 0 && (
        <View style={styles.typingRow}>
          <TypingDots color={theme.textMuted} />
          <Text style={styles.typingText}>
            {typing.length === 1 ? `${typing[0]} is typing` : `${typing.length} people are typing`}
          </Text>
        </View>
      )}

      {replyTo && (
        <View style={styles.replyBar}>
          <View style={styles.replyBarText}>
            <Text style={styles.replyBarName}>Replying to {replyTo.sender === meId ? 'yourself' : nameOf(replyTo.sender)}</Text>
            <Text style={styles.replyBarBody} numberOfLines={1}>
              {previewText(replyTo)}
            </Text>
          </View>
          <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
            <Icon name="close" size={16} color={theme.textMuted} />
          </Pressable>
        </View>
      )}

      {uploadStatus && (
        <View style={styles.uploadRow}>
          <ActivityIndicator size="small" color={theme.textMuted} />
          <Text style={styles.uploadText} numberOfLines={1}>
            {uploadStatus}
          </Text>
        </View>
      )}

      <View style={styles.composer}>
        <Pressable style={styles.attachButton} onPress={() => setAttachOpen(true)} accessibilityLabel="Attach" disabled={sending}>
          {sending ? <ActivityIndicator color={theme.text} /> : <Icon name="attach" size={18} color={theme.text} />}
        </Pressable>
        <TextInput
          style={styles.composerInput}
          value={draft}
          onChangeText={onChangeDraft}
          placeholder="Message"
          placeholderTextColor={theme.textMuted}
          multiline
          // Same reason as super-badger: keep the keyboard up while sending
          // so the resize doesn't collide with the new bubble landing.
          blurOnSubmit={false}
          onKeyPress={e => {
            // Enter sends on web; Shift+Enter is a newline.
            const ne = e.nativeEvent as any;
            if (Platform.OS === 'web' && ne.key === 'Enter' && !ne.shiftKey) {
              (e as any).preventDefault?.();
              doSend();
            }
          }}
        />
        <Pressable style={styles.sendButton} onPress={doSend} accessibilityLabel="Send">
          <Icon name="send" size={18} color={theme.primaryText} />
        </Pressable>
      </View>

      <Overlay visible={attachOpen} onClose={() => setAttachOpen(false)} style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <Pressable style={styles.menuRow} onPress={() => doAttach('image')}>
              <Text style={styles.menuRowText}>Photo</Text>
            </Pressable>
            <View style={styles.menuDivider} />
            <Pressable style={styles.menuRow} onPress={() => doAttach('file')}>
              <Text style={styles.menuRowText}>File</Text>
            </Pressable>
            <Text style={styles.sheetHint}>Encrypted on this device before upload. Photos are re-encoded, which strips location data.</Text>
          </View>
      </Overlay>
    </View>
  );

  function previewText(m: ChatMessage): string {
    const c = m.content;
    if (!c) return 'Encrypted message';
    if (c.t === 'text') return c.body;
    if (c.t === 'file') return c.body || `📎 ${c.files.map(f => f.name).join(', ')}`;
    return '';
  }
}

// Same approach as super-badger's ChatList: natural order (no `inverted`,
// which is flaky on react-native-web), pinned to the bottom while you're
// there, paging older history in as you scroll up.
function ChatList({
  room,
  meId,
  isAdmin,
  nameOf,
  styles,
  theme,
  onReply,
}: {
  room: Room;
  meId: string;
  isAdmin: boolean;
  nameOf: (id: string) => string;
  styles: Styles;
  theme: Theme;
  onReply: (m: ChatMessage) => void;
}): React.JSX.Element {
  const listRef = useRef<FlatList>(null);
  const [showJump, setShowJump] = useState(false);
  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null);
  // Long-press on a message's reactions: the sheet listing who reacted with what.
  const [whoFor, setWhoFor] = useState<ChatMessage | null>(null);
  const [viewer, setViewerRaw] = useState<{uri: string; ref: FileRef} | null>(null);
  const [viewerSave, setViewerSave] = useState<'saving' | 'saved' | {error: string} | null>(null);
  const setViewer = (v: typeof viewer) => {
    setViewerSave(null);
    setViewerRaw(v);
  };
  const saveViewed = async () => {
    if (!viewer || viewerSave === 'saving') return;
    setViewerSave('saving');
    try {
      const saved = await saveFileAs(viewer.ref.name, viewer.ref.mime, () => fetchFile(room.key, viewer.ref));
      setViewerSave(saved ? 'saved' : null);
    } catch (e) {
      setViewerSave({error: (e as Error).message || "Couldn't save"});
    }
  };
  const loadingOlderRef = useRef(false);

  const messages = room.messages;
  const byId = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages]);

  // Who has read up to which message: shown under the newest message they've
  // read, only for messages I sent.
  const seenBy = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [reader, upTo] of Object.entries(room.receipts)) {
      if (reader === meId) continue;
      (out[upTo] ??= []).push(reader);
    }
    return out;
  }, [room.receipts, meId]);

  // The list is inverted: newest first, drawn bottom-up, so it opens at the
  // bottom and stays anchored there as messages arrive, with no scrolling
  // to do. Offset 0 is the bottom; the "end" is the top, where older
  // messages load.
  const newestFirst = useMemo(() => [...messages].reverse(), [messages]);
  const handleScroll = (e: any) => {
    const {contentOffset, layoutMeasurement} = e.nativeEvent;
    const far = contentOffset.y > layoutMeasurement.height * 1.5;
    if (far !== showJump) setShowJump(far);
  };
  const loadEarlier = () => {
    if (!room.hasMore || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    loadOlder(room.key).finally(() => (loadingOlderRef.current = false));
  };

  const renderItem = ({item, index}: {item: ChatMessage; index: number}) => {
    // Inverted: the message before this one in time is the next in the list.
    const prev = newestFirst[index + 1];
    const next = newestFirst[index - 1];
    const mine = item.sender === meId;
    const grouped = !!prev && sameGroup(prev, item);
    const lastInGroup = !next || !sameGroup(item, next);
    return (
      <MessageRow
        msg={item}
        mine={mine}
        showName={!mine && !grouped}
        grouped={grouped}
        lastInGroup={lastInGroup}
        name={nameOf(item.sender)}
        reply={item.content && 'replyTo' in item.content && item.content.replyTo ? byId.get(item.content.replyTo) : undefined}
        nameOf={nameOf}
        reactions={room.reactions[item.id]}
        seenBy={mine ? seenBy[item.id]?.map(nameOf) : undefined}
        meId={meId}
        roomKey={room.key}
        styles={styles}
        theme={theme}
        onLongPress={() => {
          if (!item.content || item.pending) return;
          tick();
          setMenuFor(item);
        }}
        onReact={emoji => react(room.key, item.id, emoji).catch(() => {})}
        onOpenImage={setViewer}
        onShowReactions={setWhoFor}
      />
    );
  };

  return (
    <View style={styles.chatContainer}>
      {/* The same still constellation as the room list, behind the messages. */}
      <PixelField />
      <FlatList
        ref={listRef}
        style={styles.chat}
        inverted
        data={newestFirst}
        keyExtractor={m => m.id}
        renderItem={renderItem}
        contentContainerStyle={styles.chatContent}
        onScroll={handleScroll}
        scrollEventThrottle={32}
        onEndReached={loadEarlier}
        onEndReachedThreshold={0.5}
        // Inverted, the footer is drawn at the top: where the history starts.
        ListFooterComponent={
          <View>
            {room.loading && <ActivityIndicator style={styles.olderSpinner} size="small" color={theme.textMuted} />}
            {!room.hasMore && room.loaded && (
              <View style={styles.startNotice}>
                <Icon name="shield" size={14} color={theme.textMuted} />
                <Text style={styles.startNoticeText}>
                  Messages here are end-to-end encrypted. You see history from when you joined.
                  {room.view?.retentionDays ? ` They're deleted after ${room.view.retentionDays} days.` : ''}
                </Text>
              </View>
            )}
            {!room.hasMore && room.loaded && room.view?.wiped && (
              <View style={styles.startNotice}>
                <Icon name="trash" size={14} color={theme.textMuted} />
                <Text style={styles.startNoticeText}>
                  Chat history wiped by {room.view.wiped.by === meId ? 'you' : nameOf(room.view.wiped.by)} ·{' '}
                  {new Date(room.view.wiped.at).toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'})}
                </Text>
              </View>
            )}
          </View>
        }
        initialNumToRender={20}
        maxToRenderPerBatch={10}
        windowSize={9}
      />
      {showJump && (
        <Pressable
          style={styles.jumpButton}
          onPress={() => {
            setShowJump(false);
            listRef.current?.scrollToOffset({offset: 0, animated: true});
          }}>
          <Text style={styles.jumpText}>↓ Jump to bottom</Text>
        </Pressable>
      )}

      <Overlay visible={menuFor !== null} onClose={() => setMenuFor(null)} style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.reactRow}>
              {QUICK_REACTIONS.map(e => (
                <Pressable
                  key={e}
                  style={styles.reactPick}
                  onPress={() => {
                    react(room.key, menuFor!.id, e).catch(() => {});
                    setMenuFor(null);
                  }}>
                  <Text style={styles.reactPickText}>{e}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.menuDivider} />
            <Pressable
              style={styles.menuRow}
              onPress={() => {
                onReply(menuFor!);
                setMenuFor(null);
              }}>
              <Text style={styles.menuRowText}>Reply</Text>
            </Pressable>
            {menuFor?.content && (menuFor.content.t === 'text' || (menuFor.content.t === 'file' && menuFor.content.body)) ? (
              <>
                <View style={styles.menuDivider} />
                <Pressable
                  style={styles.menuRow}
                  onPress={() => {
                    const c = menuFor!.content!;
                    Clipboard.setString(c.t === 'text' ? c.body : c.t === 'file' ? c.body ?? '' : '');
                    setMenuFor(null);
                  }}>
                  <Text style={styles.menuRowText}>Copy</Text>
                </Pressable>
              </>
            ) : null}
            {menuFor && (menuFor.sender === meId || isAdmin) && (
              <>
                <View style={styles.menuDivider} />
                <Pressable
                  style={styles.menuRow}
                  onPress={() => {
                    const m = menuFor!;
                    setMenuFor(null);
                    platformConfirm(
                      'Delete for everyone?',
                      'This removes the message from the server and from everyone in the room.',
                      'Delete',
                      () => deleteMessage(room.key, m).catch(() => {}),
                    );
                  }}>
                  <Text style={[styles.menuRowText, styles.destructive]}>Delete for everyone</Text>
                </Pressable>
              </>
            )}
          </View>
      </Overlay>

      <Overlay visible={whoFor !== null} onClose={() => setWhoFor(null)} style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          {whoFor &&
            Object.entries(room.reactions[whoFor.id] ?? {})
              .filter(([, who]) => who.length > 0)
              .map(([emoji, who]) => (
                <View key={emoji} style={styles.whoRow}>
                  <Text style={styles.whoEmoji}>{emoji}</Text>
                  <Text style={styles.whoNames}>{who.map(id => (id === meId ? 'You' : nameOf(id))).join(', ')}</Text>
                  {who.includes(meId) && (
                    <Pressable
                      style={styles.whoRemove}
                      hitSlop={6}
                      onPress={() => {
                        const target = whoFor.id;
                        setWhoFor(null);
                        unreact(room.key, target).catch(() => {});
                      }}
                      accessibilityLabel="Remove my reaction">
                      <Text style={styles.whoRemoveText}>Remove</Text>
                    </Pressable>
                  )}
                </View>
              ))}
        </View>
      </Overlay>

      {viewer && (
        <ImageViewer
          key={viewer.uri}
          uri={viewer.uri}
          onClose={() => setViewer(null)}
          footer={
            <>
              <View style={styles.viewerActions}>
                <Pressable style={styles.viewerButton} onPress={saveViewed} disabled={viewerSave === 'saving'}>
                  {viewerSave === 'saving' ? <ActivityIndicator size="small" color="#fff" /> : <Icon name="download" size={18} color="#fff" />}
                  <Text style={styles.viewerButtonText}>
                    {viewerSave === 'saving' ? 'Saving…' : viewerSave === 'saved' ? 'Saved' : 'Save'}
                  </Text>
                </Pressable>
                <Pressable style={styles.viewerButton} onPress={() => setViewer(null)}>
                  <Icon name="close" size={18} color="#fff" />
                  <Text style={styles.viewerButtonText}>Close</Text>
                </Pressable>
              </View>
              {viewerSave && typeof viewerSave === 'object' && (
                <Text style={styles.viewerError}>Couldn't save: {viewerSave.error}</Text>
              )}
            </>
          }
        />
      )}
    </View>
  );
}

/** Messages from one sender this close together stack as a group: one name, one time. */
const GROUP_MS = 3 * 60_000;

/** Two taps closer than this are a double-tap (which reacts). */
const DOUBLE_TAP_MS = 280;
const sameGroup = (a: ChatMessage, b: ChatMessage) => a.sender === b.sender && b.createdAt - a.createdAt < GROUP_MS;

const MessageRow = React.memo(function MessageRow({
  msg,
  mine,
  showName,
  grouped,
  lastInGroup,
  name,
  reply,
  nameOf,
  reactions,
  seenBy,
  meId,
  roomKey,
  styles,
  theme,
  onLongPress,
  onReact,
  onOpenImage,
  onShowReactions,
}: {
  msg: ChatMessage;
  mine: boolean;
  showName: boolean;
  /** follows a message from the same sender: sits tight under it */
  grouped: boolean;
  /** ends its group: carries the time (and their picture) */
  lastInGroup: boolean;
  name: string;
  reply?: ChatMessage;
  nameOf: (id: string) => string;
  reactions?: Record<string, string[]>;
  seenBy?: string[];
  meId: string;
  roomKey: string;
  styles: Styles;
  theme: Theme;
  onLongPress: () => void;
  onReact: (emoji: string) => void;
  onOpenImage: (v: {uri: string; ref: FileRef}) => void;
  /** Long-press on the reactions: who reacted with what. */
  onShowReactions: (m: ChatMessage) => void;
}): React.JSX.Element {
  const c = msg.content;
  const textColor = mine ? theme.bubbleUserText : theme.bubbleAssistantText;
  const time = new Date(msg.createdAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

  // Reactions: who reacted with what, and which are mine.
  const entries = reactions ? Object.entries(reactions).filter(([, who]) => who.length > 0) : [];
  const total = entries.reduce((n, [, who]) => n + who.length, 0);
  const mineReacted = entries.filter(([, who]) => who.includes(meId)).map(([e]) => e);
  const canReact = !!c && !msg.pending;

  // Double-tap adds the default reaction (from Settings); it never removes
  // one (tap the reactions to do that). A single tap's own action (opening an
  // image, saving a file) waits a moment, in case a second tap is coming.
  const lastTap = useRef(0);
  const singleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (singleTimer.current) clearTimeout(singleTimer.current);
    },
    [],
  );
  const tap = (single?: () => void) => {
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      if (singleTimer.current) clearTimeout(singleTimer.current);
      const e = settingsStore.get().doubleTapReaction;
      if (canReact && !reactions?.[e]?.includes(meId)) {
        tick();
        onReact(e);
      }
      return;
    }
    lastTap.current = now;
    if (single) singleTimer.current = setTimeout(single, DOUBLE_TAP_MS);
  };
  // Tapping the reactions takes mine back off, or joins in with the default.
  const tapReactions = () => {
    if (!canReact) return;
    if (mineReacted.length) mineReacted.forEach(e => onReact(e));
    else onReact(settingsStore.get().doubleTapReaction);
  };

  return (
    <View style={[styles.rowOuter, mine ? styles.rowOuterMine : null, grouped && styles.rowGrouped]}>
      {!mine && (
        <View style={styles.avatarCol}>
          {lastInGroup && <Avatar roomKey={roomKey} member={msg.sender} name={name} size={28} />}
        </View>
      )}
      <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
        {showName && <Text style={styles.senderName}>{name}</Text>}
        <View style={[styles.bubbleWrap, entries.length > 0 && styles.bubbleWrapReacted]}>
          <Pressable
            style={[
              styles.bubble,
              mine ? styles.bubbleMine : styles.bubbleTheirs,
              msg.pending && styles.bubblePending,
              !c && styles.bubbleBroken,
            ]}
            onPress={() => tap()}
            onLongPress={onLongPress}
            delayLongPress={300}>
            {reply && (
              <View style={[styles.quote, {borderLeftColor: mine ? theme.bubbleUserText : theme.primary}]}>
                <Text style={[styles.quoteName, {color: textColor}]}>{nameOf(reply.sender)}</Text>
                <Text style={[styles.quoteText, {color: textColor}]} numberOfLines={2}>
                  {reply.content?.t === 'text' ? reply.content.body : reply.content?.t === 'file' ? '📎 Attachment' : 'Message'}
                </Text>
              </View>
            )}
            {!c && <Text style={[styles.brokenText, {color: textColor}]}>🔒 {msg.error ?? 'Encrypted message'}</Text>}
            {c?.t === 'file' &&
              c.files.map(f =>
                f.mime.startsWith('image/') ? (
                  <ImageAttachment
                    key={f.blob}
                    roomKey={roomKey}
                    file={f}
                    styles={styles}
                    theme={theme}
                    onOpen={onOpenImage}
                    onTap={tap}
                    onLongPress={onLongPress}
                  />
                ) : (
                  <FileAttachment
                    key={f.blob}
                    roomKey={roomKey}
                    file={f}
                    color={textColor}
                    styles={styles}
                    onTap={tap}
                    onLongPress={onLongPress}
                  />
                ),
              )}
            {c && (c.t === 'text' || (c.t === 'file' && c.body)) ? (
              <MarkdownText text={c.t === 'text' ? c.body : c.body!} color={textColor} theme={theme} />
            ) : null}
          </Pressable>
          {entries.length > 0 && (
            // On the bubble's inner bottom corner: up to three emoji stacked
            // over each other, and the total when more than one person reacted.
            <Pressable
              style={[styles.reactPill, mine ? styles.reactPillMine : styles.reactPillTheirs, mineReacted.length > 0 && styles.reactPillOwn]}
              onPress={tapReactions}
              onLongPress={() => {
                tick();
                onShowReactions(msg);
              }}
              delayLongPress={300}
              hitSlop={6}
              accessibilityLabel={entries.map(([e, who]) => `${e} from ${who.map(nameOf).join(', ')}`).join('; ')}>
              {entries.slice(0, 3).map(([e], i) => (
                <Text key={e} style={[styles.reactPillEmoji, i > 0 && styles.reactPillEmojiStacked]}>
                  {e}
                </Text>
              ))}
              {total > 1 && <Text style={styles.reactPillCount}>{total}</Text>}
            </Pressable>
          )}
        </View>
        {(lastInGroup || msg.pending) && <Text style={styles.time}>{msg.pending ? 'sending…' : time}</Text>}
        {seenBy && seenBy.length > 0 && <Text style={styles.seen}>Seen by {seenBy.join(', ')}</Text>}
      </View>
    </View>
  );
});

function ImageAttachment({
  roomKey,
  file,
  styles,
  theme,
  onOpen,
  onTap,
  onLongPress,
}: {
  roomKey: string;
  file: FileRef;
  styles: Styles;
  theme: Theme;
  onOpen: (v: {uri: string; ref: FileRef}) => void;
  /** The message's tap handler: runs `single` unless it turns into a double-tap (a reaction). */
  onTap: (single?: () => void) => void;
  onLongPress: () => void;
}) {
  // Straight from memory when it's been shown before: no spinner, no reload.
  const [img, setImg] = useState<ShownImage | null>(() => peekImage(file));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (img) return;
    let live = true;
    loadImage(roomKey, file)
      .then(shown => live && setImg(shown))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomKey, file]);
  const ratio = file.w && file.h ? file.w / file.h : 4 / 3;
  if (failed) return <Text style={styles.brokenText}>🔒 Image unavailable</Text>;
  return (
    <Pressable
      onPress={() => onTap(() => img && onOpen({uri: img.uri, ref: file}))}
      onLongPress={onLongPress}
      delayLongPress={300}>
      {img ? (
        <Image source={{uri: img.uri}} style={[styles.image, {aspectRatio: ratio}]} resizeMode="cover" />
      ) : (
        <View style={[styles.image, styles.imageLoading, {aspectRatio: ratio}]}>
          <ActivityIndicator color={theme.textMuted} />
        </View>
      )}
    </Pressable>
  );
}

function FileAttachment({
  roomKey,
  file,
  color,
  styles,
  onTap,
  onLongPress,
}: {
  roomKey: string;
  file: FileRef;
  color: string;
  styles: Styles;
  /** The message's tap handler: runs `single` unless it turns into a double-tap (a reaction). */
  onTap: (single?: () => void) => void;
  onLongPress: () => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const save = async () => {
    try {
      // The save dialog opens first; downloading and decrypting start
      // once a location is picked.
      const saved = await saveFileAs(file.name, file.mime, () => {
        setStatus('Downloading…');
        return fetchFile(roomKey, file);
      });
      setStatus(saved ? `Saved as ${saved.name}` : null);
    } catch (e) {
      setStatus(`Couldn't save: ${(e as Error).message}`);
    }
  };
  return (
    <Pressable
      style={styles.fileChip}
      disabled={status === 'Downloading…'}
      onPress={() => onTap(save)}
      onLongPress={onLongPress}
      delayLongPress={300}>
      <Icon name="file" size={18} color={color} />
      <View style={styles.fileChipText}>
        <Text style={[styles.fileName, {color}]} numberOfLines={1}>
          {file.name}
        </Text>
        <Text style={[styles.fileMeta, {color}]}>{status ?? `${formatSize(file.size)} · tap to save`}</Text>
      </View>
    </Pressable>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    container: {flex: 1, backgroundColor: theme.bg},
    center: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: theme.bg},
    retryButton: {paddingHorizontal: 18, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.surfaceAlt},
    retryText: {color: theme.text, fontWeight: '600'},
    muted: {color: theme.textMuted},
    errorRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: theme.dangerBg,
      borderBottomWidth: 1,
      borderBottomColor: theme.danger,
    },
    errorText: {flex: 1, color: theme.danger, fontSize: 13},
    // The page color sits under the constellation; the list is see-through.
    chatContainer: {flex: 1, backgroundColor: theme.bg},
    chat: {flex: 1},
    chatContent: {padding: 16, paddingBottom: 24, gap: 4},
    olderSpinner: {paddingVertical: 8},
    startNotice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      alignSelf: 'center',
      maxWidth: 360,
      padding: 10,
      marginBottom: 12,
      borderRadius: 8,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
    },
    startNoticeText: {flex: 1, fontSize: 12, color: theme.textMuted},
    rowOuter: {flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginTop: 10},
    rowOuterMine: {justifyContent: 'flex-end'},
    // Same sender within GROUP_MS: stack tightly, no repeated name or time.
    rowGrouped: {marginTop: 2},
    avatarCol: {width: 28, marginBottom: 16},
    row: {maxWidth: '80%', flexShrink: 1},
    rowMine: {alignSelf: 'flex-end', alignItems: 'flex-end'},
    rowTheirs: {alignSelf: 'flex-start', alignItems: 'flex-start'},
    senderName: {fontSize: 11, fontWeight: '700', color: theme.textMuted, marginBottom: 2, marginLeft: 4},
    bubble: {borderRadius: 10, padding: 10, gap: 6},
    bubbleMine: {backgroundColor: theme.bubbleUser},
    bubbleTheirs: {backgroundColor: theme.bubbleAssistant},
    // Dashed, like super-badger's queued messages: "not sent yet".
    bubblePending: {opacity: 0.7, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.textMuted},
    bubbleBroken: {opacity: 0.8},
    brokenText: {fontStyle: 'italic', fontSize: 13, color: theme.textMuted},
    time: {fontSize: 10, color: theme.textMuted, marginTop: 3, marginHorizontal: 4},
    quote: {borderLeftWidth: 3, paddingLeft: 8, opacity: 0.85},
    quoteName: {fontSize: 11, fontWeight: '700'},
    quoteText: {fontSize: 12},
    image: {width: 240, maxWidth: '100%', borderRadius: 6, backgroundColor: theme.surfaceAlt},
    imageLoading: {alignItems: 'center', justifyContent: 'center'},
    fileChip: {flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 180},
    fileChipText: {flexShrink: 1},
    fileName: {fontSize: 13, fontWeight: '600'},
    fileMeta: {fontSize: 11, opacity: 0.75},
    // The bubble and the reaction pill pinned to its corner.
    bubbleWrap: {position: 'relative'},
    bubbleWrapReacted: {marginBottom: 14},
    reactPill: {
      position: 'absolute',
      bottom: -14,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 5,
      paddingVertical: 2,
      borderRadius: 12,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
    },
    // On the inner corner: toward the middle of the screen.
    reactPillMine: {left: -6},
    reactPillTheirs: {right: -6},
    reactPillOwn: {borderColor: theme.primary},
    reactPillEmoji: {fontSize: 13},
    reactPillEmojiStacked: {marginLeft: -4},
    reactPillCount: {fontSize: 11, fontWeight: '700', color: theme.textMuted, marginLeft: 3},
    whoRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10},
    whoEmoji: {fontSize: 20},
    whoNames: {flex: 1, fontSize: 14, color: theme.text},
    whoRemove: {paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, backgroundColor: theme.surfaceAlt},
    whoRemoveText: {fontSize: 12, fontWeight: '700', color: theme.danger},
    seen: {fontSize: 10, color: theme.textMuted, marginTop: 2},
    typingRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 6},
    typingText: {fontSize: 11, color: theme.textMuted, fontStyle: 'italic'},
    uploadRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6},
    uploadText: {flex: 1, fontSize: 12, color: theme.textMuted},
    replyBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      backgroundColor: theme.surface,
    },
    replyBarText: {flex: 1, borderLeftWidth: 3, borderLeftColor: theme.primary, paddingLeft: 8},
    replyBarName: {fontSize: 11, fontWeight: '700', color: theme.primary},
    replyBarBody: {fontSize: 12, color: theme.textMuted},
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      padding: 12,
      gap: 8,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      backgroundColor: theme.bg,
    },
    attachButton: {
      width: 40,
      minHeight: 40,
      borderRadius: 6,
      backgroundColor: theme.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    composerInput: {
      flex: 1,
      maxHeight: 140,
      minHeight: 40,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: theme.text,
      backgroundColor: theme.surface,
      fontSize: 15,
    },
    sendButton: {
      minHeight: 40,
      backgroundColor: theme.primary,
      borderRadius: 6,
      paddingHorizontal: 16,
      justifyContent: 'center',
    },
    jumpButton: {
      position: 'absolute',
      bottom: 12,
      alignSelf: 'center',
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: theme.primary,
      elevation: 4,
    },
    jumpText: {color: theme.primaryText, fontSize: 13, fontWeight: '700'},
    sheetBackdrop: {justifyContent: 'flex-end', padding: 12},
    sheet: {
      borderRadius: 12,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
      overflow: 'hidden',
      maxWidth: 480,
      width: '100%',
      alignSelf: 'center',
    },
    sheetHint: {fontSize: 11, color: theme.textMuted, padding: 12, paddingTop: 4},
    menuRow: {paddingHorizontal: 16, paddingVertical: 14},
    menuRowText: {fontSize: 15, fontWeight: '600', color: theme.text},
    destructive: {color: theme.danger},
    menuDivider: {height: 1, backgroundColor: theme.border},
    reactRow: {flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 10},
    reactPick: {padding: 6},
    reactPickText: {fontSize: 24},
    viewerActions: {flexDirection: 'row', justifyContent: 'center', gap: 24, padding: 20},
    viewerButton: {flexDirection: 'row', alignItems: 'center', gap: 6, padding: 10},
    viewerButtonText: {color: '#fff', fontWeight: '700'},
    viewerError: {color: '#ff9b9b', textAlign: 'center', paddingHorizontal: 20, paddingBottom: 16},
  });
}
