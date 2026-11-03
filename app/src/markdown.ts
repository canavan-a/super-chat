// Markdown rendering for the chat transcript: https links and headings. Not a
// spec-complete markdown parser — everything else shows as typed.
//
// Table detection (see table.ts, git history) was tried and pulled back out
// — between the rendering bugs it caused and the extra per-line scanning
// cost on every streaming re-parse, it wasn't worth what it added. Code
// blocks, inline code, bold/italic and lists (git history) went the same way.

export interface InlineRun {
  value: string;
  /** Set on a detected https:// link: the URL to open. */
  url?: string;
}

export interface HeadingSegment {
  kind: 'heading';
  level: number;
  runs: InlineRun[];
}

export interface ParagraphSegment {
  kind: 'paragraph';
  runs: InlineRun[];
}

export type MarkdownSegment = HeadingSegment | ParagraphSegment;

// Only https:// links, never http:// or other schemes.
const LINK_RE = /https:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?'"*_\]}>]+$/;

// Sentence punctuation after a link isn't part of it; a closing paren is
// only when the link opened one (wikipedia-style URLs).
function trimLink(url: string): string {
  for (;;) {
    const before = url;
    url = url.replace(TRAILING_PUNCT_RE, '');
    if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
      url = url.slice(0, -1);
    }
    if (url === before) return url;
  }
}

function parseInline(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text))) {
    const value = trimLink(m[0]);
    if (value.length <= 'https://'.length) continue;
    if (m.index > last) runs.push({value: text.slice(last, m.index)});
    // Android matches the scheme case-sensitively; keyboards capitalise it.
    runs.push({value, url: 'https' + value.slice(5)});
    last = m.index + value.length;
    LINK_RE.lastIndex = last;
  }
  if (last < text.length) runs.push({value: text.slice(last)});
  return runs;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

export function parseMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let paraBuffer: string[] = [];

  const flushPara = () => {
    if (paraBuffer.length) {
      segments.push({kind: 'paragraph', runs: parseInline(paraBuffer.join('\n'))});
      paraBuffer = [];
    }
  };

  for (const line of text.split('\n')) {
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      flushPara();
      segments.push({kind: 'heading', level: headingMatch[1].length, runs: parseInline(headingMatch[2])});
    } else if (line.trim() === '') {
      flushPara();
    } else {
      paraBuffer.push(line);
    }
  }
  flushPara();
  return segments;
}
