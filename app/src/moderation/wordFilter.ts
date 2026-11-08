// The content filter (Settings → Content filter): words on your own list, and
// optionally the built-in list of slurs and profanity (words.ts, never shown),
// show as **** in messages. It only changes what this device shows: messages
// are end-to-end encrypted, so the server can't filter anything, and what's
// sent stays as typed. Off by default; your list starts empty and the
// built-in list is off until you turn it on.
import {useEffect, useState} from 'react';

import {settingsStore, type Settings} from '../settings';
import {BUILT_IN_WORDS} from './words';

export type FilterSettings = Pick<Settings, 'filterWords' | 'filterList' | 'filterBuiltIn'>;

// Word edges: start/end, whitespace or punctuation. Not \b, which only knows
// ASCII letters, so it would miss "café" or a word next to an accent.
const EDGE = `\\s.,!?;:'"()\\[\\]{}<>/\\\\|@#$%^&*+=~\`-`;
const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let cached: {list: string[]; builtIn: boolean; re: RegExp | null} | null = null;
function regexFor(list: string[], builtIn: boolean): RegExp | null {
  if (cached?.list === list && cached.builtIn === builtIn) return cached.re;
  const words = [...(builtIn ? BUILT_IN_WORDS : []), ...list]
    .map(w => w.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length) // longest first, so a phrase beats a word inside it
    .map(escape);
  const re = words.length ? new RegExp(`(^|[${EDGE}])(${words.join('|')})(?=$|[${EDGE}])`, 'gi') : null;
  cached = {list, builtIn, re};
  return re;
}

/** The text with each listed word masked, when the filter is on. */
export function censor(text: string, f: FilterSettings = settingsStore.get()): string {
  if (!f.filterWords) return text;
  const re = regexFor(f.filterList, f.filterBuiltIn);
  return re ? text.replace(re, (_m, edge: string, word: string) => edge + '*'.repeat(word.length)) : text;
}

/** Normalize a word typed into the list: trimmed, lower case, inner spaces collapsed. */
export const cleanWord = (w: string) => w.trim().toLowerCase().replace(/\s+/g, ' ');

/** The filter's settings, re-rendering when they change. */
export function useFilterWords(): FilterSettings {
  const pick = (s: Settings): FilterSettings => ({
    filterWords: s.filterWords,
    filterList: s.filterList,
    filterBuiltIn: s.filterBuiltIn,
  });
  const [f, setF] = useState(() => pick(settingsStore.get()));
  useEffect(
    () =>
      settingsStore.subscribe(s =>
        setF(prev =>
          prev.filterWords === s.filterWords && prev.filterList === s.filterList && prev.filterBuiltIn === s.filterBuiltIn
            ? prev
            : pick(s),
        ),
      ),
    [],
  );
  return f;
}
