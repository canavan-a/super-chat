// Contact and abuse reports go by email, in the user's own mail app: they
// see exactly what's sent before sending it, and the app sends nothing by
// itself. A report never includes message content, only what's needed to
// find the room on the server (see the terms, terms.ts).
import {Linking} from 'react-native';

import {CONTACT} from './policy';

const mailto = (subject: string, body: string) =>
  `mailto:${CONTACT}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

export const supportMailto = () => mailto('Super Chat support', '');

/** A member reported from a chat: the room and their key in it, which is all the server knows them by. */
export interface ReportTarget {
  server: string;
  room: string;
  member: string;
  name: string;
}

export function reportMailto(target?: ReportTarget): string {
  const found = target
    ? `Server: ${target.server}\nRoom: ${target.room}\nMember: ${target.name} (${target.member})\n\n`
    : 'Which room is it (its name, or an invite link to it)?\n\n';
  return mailto('Super Chat report', `${found}What happened?\n\n`);
}

export const openMail = (url: string) => Linking.openURL(url).catch(() => {});
