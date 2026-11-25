// The composer's text box, with each @mention that will go out shown as a
// pill. iOS and Android style text inside a TextInput directly (as children);
// a web textarea can't, so there the pills are drawn on a copy of the text
// laid behind it, which scrolls with it.
import React, {forwardRef, useEffect, useRef, useState} from 'react';
import {Platform, StyleProp, StyleSheet, Text, TextInput, TextInputProps, TextStyle, View} from 'react-native';

import {tint} from './Markdown';

export interface MentionInputProps extends Omit<TextInputProps, 'value' | 'children' | 'style'> {
  value: string;
  /** The value in pieces (see splitTypedMentions): those with an id are mentions. */
  spans: {text: string; id?: string}[];
  /** The pill's colour. */
  accent: string;
  style?: StyleProp<TextStyle>;
}

export const MentionInput = forwardRef<TextInput, MentionInputProps>(function MentionInput(
  {value, spans, accent, style, ...rest},
  ref,
) {
  const hasMention = spans.some(s => s.id);
  if (Platform.OS !== 'web') {
    return (
      <TextInput ref={ref} style={style} {...rest}>
        {hasMention
          ? spans.map((s, i) =>
              s.id ? (
                <Text key={i} style={[pillText, {color: accent, backgroundColor: tint(accent, 0.16)}]}>
                  {s.text}
                </Text>
              ) : (
                <Text key={i}>{s.text}</Text>
              ),
            )
          : value}
      </TextInput>
    );
  }
  return <WebMentionInput ref={ref} value={value} spans={spans} accent={accent} style={style} {...rest} />;
});

const WebMentionInput = forwardRef<TextInput, MentionInputProps>(function WebMentionInput(
  {value, spans, accent, style, ...rest},
  ref,
) {
  const inner = useRef<TextInput | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  useEffect(() => {
    // react-native-web's TextInput is the textarea itself.
    const el = inner.current as unknown as HTMLTextAreaElement | null;
    if (!el?.addEventListener) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const el = inner.current as unknown as HTMLTextAreaElement | null;
    if (el) setScrollTop(el.scrollTop ?? 0);
  }, [value]);

  const flat = StyleSheet.flatten(style) ?? {};
  const {backgroundColor, color, ...box} = flat;
  const metrics = {fontSize: flat.fontSize, lineHeight: flat.lineHeight ?? WEB_LINE_HEIGHT, fontFamily: flat.fontFamily};
  const hasMention = spans.some(s => s.id);
  return (
    <View style={[styles.wrap, {flex: flat.flex, alignSelf: flat.alignSelf}]}>
      {hasMention && (
        <View
          pointerEvents="none"
          style={[
            box,
            styles.backdrop,
            {backgroundColor, borderColor: 'transparent', flex: undefined, minHeight: undefined, maxHeight: undefined},
          ]}>
          <Text style={[metrics, styles.ghost, {transform: [{translateY: -scrollTop}]}]}>
            {spans.map((s, i) =>
              s.id ? (
                <Text
                  key={i}
                  style={[
                    styles.webPill,
                    {
                      backgroundColor: tint(accent, 0.18),
                      // A ring of the same colour: room around the name without moving the text.
                      boxShadow: `0 0 0 2px ${tint(accent, 0.18)}`,
                    } as TextStyle,
                  ]}>
                  {s.text}
                </Text>
              ) : (
                <Text key={i}>{s.text}</Text>
              ),
            )}
            {/* A trailing newline in a textarea still takes a line. */}
            {value.endsWith('\n') ? ' ' : null}
          </Text>
        </View>
      )}
      <TextInput
        ref={node => {
          inner.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        value={value}
        style={[style, {flex: undefined, lineHeight: metrics.lineHeight}, hasMention && {backgroundColor: 'transparent'}]}
        {...rest}
      />
    </View>
  );
});

const WEB_LINE_HEIGHT = 20;

const pillText: TextStyle = {fontWeight: '600'};

const styles = StyleSheet.create({
  wrap: {position: 'relative'},
  backdrop: {...StyleSheet.absoluteFillObject, overflow: 'hidden'},
  ghost: {color: 'transparent'},
  webPill: {borderRadius: 4},
});
