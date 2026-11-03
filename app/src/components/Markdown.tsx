// Chat-bubble markdown, the same renderer super-badger uses for replies:
// paragraphs with links, and headings.
import React, {useMemo} from 'react';
import {Linking, StyleSheet, Text} from 'react-native';

import {InlineRun, parseMarkdown} from '../markdown';

const HEADING_STYLES: Record<number, object> = {
  1: {fontSize: 18, fontWeight: '800'},
  2: {fontSize: 16, fontWeight: '800'},
  3: {fontSize: 14, fontWeight: '700'},
};

export const MarkdownText = React.memo(function MarkdownText({
  text,
  color,
  onLinkLongPress,
}: {
  text: string;
  color: string;
  /** A link takes the touch from whatever it sits in, so pass that long-press on. */
  onLinkLongPress?: () => void;
}): React.JSX.Element {
  const segments = useMemo(() => parseMarkdown(text), [text]);
  const textStyle = [styles.text, {color}];
  return (
    <>
      {segments.map((seg, i) => (
        <Text
          key={i}
          style={seg.kind === 'heading' ? [textStyle, styles.heading, HEADING_STYLES[seg.level] ?? null] : textStyle}>
          <InlineRuns runs={seg.runs} onLinkLongPress={onLinkLongPress} />
        </Text>
      ))}
    </>
  );
});

function InlineRuns({
  runs,
  onLinkLongPress,
}: {
  runs: InlineRun[];
  onLinkLongPress?: () => void;
}): React.JSX.Element {
  return (
    <>
      {runs.map((run, j) =>
        run.url ? (
          <Text
            key={j}
            style={styles.link}
            // The default browser, or the app that owns the link.
            onPress={() => Linking.openURL(run.url!).catch(() => {})}
            onLongPress={onLinkLongPress}
            accessibilityRole="link">
            {run.value}
          </Text>
        ) : (
          <Text key={j}>{run.value}</Text>
        ),
      )}
    </>
  );
}

const styles = StyleSheet.create({
  text: {fontSize: 14, lineHeight: 19},
  heading: {marginTop: 2, marginBottom: 2},
  // The bubble's own text colour, which reads on both sides of the chat.
  link: {textDecorationLine: 'underline'},
});
