// Chat-bubble markdown, the same renderer super-badger uses for replies:
// paragraphs with links, and headings.
import React, {useMemo} from 'react';
import {Linking, StyleSheet, Text} from 'react-native';

import {InlineRun, parseMarkdown} from '../markdown';
import {censor, useFilterWords} from '../moderation/wordFilter';

const HEADING_STYLES: Record<number, object> = {
  1: {fontSize: 18, fontWeight: '800'},
  2: {fontSize: 16, fontWeight: '800'},
  3: {fontSize: 14, fontWeight: '700'},
};

export const MarkdownText = React.memo(function MarkdownText({
  text,
  color,
  onLinkLongPress,
  nameOf,
  meId,
}: {
  text: string;
  color: string;
  /** A link takes the touch from whatever it sits in, so pass that long-press on. */
  onLinkLongPress?: () => void;
  /** Who an @mention names (see mentions.ts); without it, mentions show as "@someone". */
  nameOf?: (id: string) => string;
  /** A mention of me stands out more. */
  meId?: string;
}): React.JSX.Element {
  const filter = useFilterWords();
  // Masked after parsing, so a link keeps its real URL.
  const segments = useMemo(
    () =>
      parseMarkdown(text).map(seg => ({
        ...seg,
        runs: seg.runs.map(run =>
          run.mention ? {...run, value: `@${nameOf?.(run.mention) ?? 'someone'}`} : {...run, value: censor(run.value, filter)},
        ),
      })),
    [text, filter, nameOf],
  );
  const textStyle = [styles.text, {color}];
  return (
    <>
      {segments.map((seg, i) => (
        <Text
          key={i}
          style={seg.kind === 'heading' ? [textStyle, styles.heading, HEADING_STYLES[seg.level] ?? null] : textStyle}>
          <InlineRuns runs={seg.runs} onLinkLongPress={onLinkLongPress} color={color} meId={meId} />
        </Text>
      ))}
    </>
  );
});

function InlineRuns({
  runs,
  onLinkLongPress,
  color,
  meId,
}: {
  runs: InlineRun[];
  onLinkLongPress?: () => void;
  color: string;
  meId?: string;
}): React.JSX.Element {
  return (
    <>
      {runs.map((run, j) =>
        run.mention ? (
          <Text key={j} style={[styles.mention, {backgroundColor: tint(color, run.mention === meId ? 0.38 : 0.18)}]}>
            {run.value}
          </Text>
        ) : run.url ? (
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
  mention: {fontWeight: '700', borderRadius: 4},
});

/** The bubble's text colour, see-through: a highlight that reads on either side of the chat. */
function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return `rgba(127,127,127,${alpha})`;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}
