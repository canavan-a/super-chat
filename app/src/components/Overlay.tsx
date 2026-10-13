import React, {useEffect} from 'react';
import {BackHandler, Pressable, StyleSheet, View, ViewStyle} from 'react-native';

/**
 * A modal layer drawn inside the app's own window. React Native's <Modal>
 * opens a separate Android window that doesn't inherit MainActivity's
 * FLAG_SECURE, so anything shown in one could be screenshotted. Every sheet
 * or viewer that can show message content uses this instead.
 */
export function Overlay({
  visible,
  onClose,
  backdrop = 'rgba(0,0,0,0.35)',
  style,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  backdrop?: string;
  /** Layout of the content area (e.g. justifyContent: 'flex-end'). */
  style?: ViewStyle;
  children: React.ReactNode;
}): React.JSX.Element | null {
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);
  if (!visible) return null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.layer]}>
      <Pressable style={[StyleSheet.absoluteFill, {backgroundColor: backdrop}]} onPress={onClose} />
      <View style={[styles.content, style]} pointerEvents="box-none">
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {zIndex: 50, elevation: 50},
  content: {flex: 1},
});
