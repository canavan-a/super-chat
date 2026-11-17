// @mentions. On the wire a mention is `<@memberId>` inside the message body,
// so it follows the person through renames; every place that shows text
// swaps the token for their current name. The composer works in names
// ("@Alice") and turns them into tokens on send (encodeMentions).
//
// A mention doesn't notify or do anything else: it's only highlighted.

/** Member IDs are 52 characters of lowercase base32 (see memberIdFromPub). */
export const MENTION_RE = /<@([a-z2-7]{52})>/g;

/** `<@id>` → `@Name`, for previews, notifications, copying and editing. */
export function mentionsToNames(text: string, nameOf: (id: string) => string): string {
  return text.replace(MENTION_RE, (_, id: string) => `@${nameOf(id)}`);
}

export interface Mentionable {
  id: string;
  name: string;
}

/**
 * `@Name` → `<@id>` for each member named. The longest names go first, so
 * "@Ann Lee" isn't taken as "@Ann" when both are in the room; a name has to
 * end at a word boundary ("@Annabel" isn't "@Ann"). `picked` (name → id) is
 * who was chosen from the list, which settles two members with one name.
 */
export function encodeMentions(text: string, members: Mentionable[], picked: Record<string, string> = {}): string {
  const byName = new Map<string, string>();
  for (const m of members) if (m.name && !byName.has(m.name)) byName.set(m.name, m.id);
  for (const [name, id] of Object.entries(picked)) if (members.some(m => m.id === id)) byName.set(name, id);
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  if (!names.length || !text.includes('@')) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '@' && (i === 0 || !isWordChar(text[i - 1]))) {
      const name = names.find(n => text.startsWith(n, i + 1) && !isWordChar(text[i + 1 + n.length] ?? ''));
      if (name) {
        out += `<@${byName.get(name)}>`;
        i += 1 + name.length;
        continue;
      }
    }
    out += text[i++];
  }
  return out;
}

const isWordChar = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);

/**
 * The `@query` being typed just before the cursor, if any: what the member
 * list filters by. Null when the cursor isn't in one.
 */
export function mentionQuery(text: string, cursor: number): {start: number; query: string} | null {
  const before = text.slice(0, cursor);
  const m = /(^|[^\p{L}\p{N}_])@([^\s@]{0,40})$/u.exec(before);
  if (!m) return null;
  return {start: before.length - m[2].length - 1, query: m[2]};
}

/** Members whose name (or any word in it) starts with the query, case-insensitively. */
export function matchMembers(members: Mentionable[], query: string, limit = 6): Mentionable[] {
  const q = query.toLowerCase();
  return members
    .filter(m => m.name && (!q || m.name.toLowerCase().split(/\s+/).some(w => w.startsWith(q)) || m.name.toLowerCase().startsWith(q)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}
