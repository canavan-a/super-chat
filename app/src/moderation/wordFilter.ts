// The content filter: listed words (words.ts) in messages show as ****. It
// only changes what this device shows: messages are end-to-end encrypted, so
// the server can't filter anything, and what's sent stays as typed. On by
// default; Settings → Content filter turns it off.
import {useEffect, useState} from 'react';

import {settingsStore} from '../settings';
import {ROOTS, WORDS} from './words';

const FILTER_RE = new RegExp(`[a-z0-9]*(?:${ROOTS.join('|')})[a-z0-9]*|\\b(?:${WORDS.join('|')})\\b`, 'gi');

/** The text with each listed word masked, when the filter is on. */
export function censor(text: string, on: boolean = settingsStore.get().filterWords): string {
  return on ? text.replace(FILTER_RE, m => '*'.repeat(m.length)) : text;
}

/** Whether the filter is on, re-rendering when it's switched. */
export function useFilterWords(): boolean {
  const [on, setOn] = useState(settingsStore.get().filterWords);
  useEffect(() => settingsStore.subscribe(s => setOn(s.filterWords)), []);
  return on;
}
