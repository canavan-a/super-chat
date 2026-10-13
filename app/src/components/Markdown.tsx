// Chat-bubble markdown, the same renderer super-badger uses for replies:
// paragraphs with bold/italic/inline code, headings, lists, and fenced code
// blocks with light highlighting and a copy button.
import React, {useMemo, useState} from 'react';
import {Clipboard, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';

import {CodeBlockSegment, InlineRun, parseMarkdown} from '../markdown';
import {Theme} from '../theme';
import {Icon} from './Icon';

const CODE_BLOCK_COLLAPSED_LINES = 12;

const HEADING_STYLES: Record<number, object> = {
  1: {fontSize: 18, fontWeight: '800'},
  2: {fontSize: 16, fontWeight: '800'},
  3: {fontSize: 14, fontWeight: '700'},
};

export const MarkdownText = React.memo(function MarkdownText({
  text,
  color,
  theme,
}: {
  text: string;
  color: string;
  theme: Theme;
}): React.JSX.Element {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const segments = useMemo(() => parseMarkdown(text), [text]);
  const tokenStyles = useMemo(() => codeTokenStyleMap(theme), [theme]);
  const textStyle = [styles.text, {color}];
  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case 'code-block':
            return <CodeBlockView key={i} seg={seg} styles={styles} theme={theme} tokenStyles={tokenStyles} />;
          case 'heading':
            return (
              <Text key={i} style={[textStyle, styles.heading, HEADING_STYLES[seg.level] ?? null]}>
                <InlineRuns runs={seg.runs} styles={styles} />
              </Text>
            );
          case 'list-item':
            return (
              <View key={i} style={styles.listItemRow}>
                <Text style={textStyle}>{seg.ordered ? '•' : '–'}</Text>
                <Text style={[textStyle, styles.listText]}>
                  <InlineRuns runs={seg.runs} styles={styles} />
                </Text>
              </View>
            );
          default:
            return (
              <Text key={i} style={textStyle}>
                <InlineRuns runs={seg.runs} styles={styles} />
              </Text>
            );
        }
      })}
    </>
  );
});

type Styles = ReturnType<typeof makeStyles>;

function InlineRuns({runs, styles}: {runs: InlineRun[]; styles: Styles}): React.JSX.Element {
  return (
    <>
      {runs.map((run, j) => (
        <Text key={j} style={[run.code && styles.inlineCode, run.bold && styles.bold, run.italic && styles.italic]}>
          {run.value}
        </Text>
      ))}
    </>
  );
}

function CodeBlockView({
  seg,
  styles,
  theme,
  tokenStyles,
}: {
  seg: CodeBlockSegment;
  styles: Styles;
  theme: Theme;
  tokenStyles: Record<string, object>;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const showToggle = seg.code.split('\n').length > CODE_BLOCK_COLLAPSED_LINES;
  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeBlockHeader}>
        {seg.lang ? <Text style={styles.codeLang}>{seg.lang}</Text> : <View style={styles.flex} />}
        <Pressable
          style={styles.codeCopyButton}
          onPress={() => {
            Clipboard.setString(seg.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          accessibilityLabel="Copy code">
          {copied ? <Text style={styles.codeCopied}>Copied</Text> : <Icon name="copy" size={14} color={theme.textMuted} />}
        </Pressable>
      </View>
      <View style={expanded ? styles.codeExpanded : styles.codeClamped}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled directionalLockEnabled>
          <Text style={styles.codeText}>
            {seg.tokens.map((tok, j) => (
              <Text key={j} style={tokenStyles[tok.type]}>
                {tok.text}
              </Text>
            ))}
          </Text>
        </ScrollView>
      </View>
      {showToggle && (
        <Text style={styles.toggle} onPress={() => setExpanded(e => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </Text>
      )}
    </View>
  );
}

function codeTokenStyleMap(theme: Theme): Record<string, object> {
  return {
    plain: {},
    keyword: {color: theme.danger, fontWeight: '700'},
    string: {color: theme.success},
    comment: {color: theme.textMuted, fontStyle: 'italic'},
    number: {color: theme.primary},
  };
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    flex: {flex: 1},
    text: {fontSize: 14, lineHeight: 19},
    heading: {marginTop: 2, marginBottom: 2},
    listItemRow: {flexDirection: 'row', gap: 6, paddingLeft: 2},
    listText: {flexShrink: 1},
    bold: {fontWeight: '700'},
    italic: {fontStyle: 'italic'},
    inlineCode: {fontFamily: 'monospace', backgroundColor: theme.inlineCodeBg, fontSize: 13},
    codeBlock: {
      backgroundColor: theme.codeBg,
      borderWidth: 1,
      borderColor: theme.codeBorder,
      borderRadius: 6,
      padding: 8,
      marginVertical: 2,
    },
    codeBlockHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4},
    codeLang: {fontSize: 10, fontWeight: '700', color: theme.textMuted, textTransform: 'uppercase'},
    codeCopyButton: {padding: 4},
    codeCopied: {fontSize: 10, fontWeight: '600', color: theme.textMuted},
    codeText: {fontFamily: 'monospace', fontSize: 12, lineHeight: 16, color: theme.codeText},
    codeClamped: {maxHeight: 16 * CODE_BLOCK_COLLAPSED_LINES, overflow: 'hidden'},
    codeExpanded: {maxHeight: 16 * 40, overflow: 'hidden'},
    toggle: {fontSize: 11, fontWeight: '600', color: theme.primary, marginTop: 6},
  });
}
