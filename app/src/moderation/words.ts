// The content filter's word list (see wordFilter.ts): slurs and the most
// explicit swearing. Kept short on purpose, so it doesn't catch everyday
// words. Lower case, no regex characters.

/** Matched as whole words only, so "spic" doesn't hit "spicy". */
export const WORDS = [
  // swearing
  'shit', 'shits', 'shitty', 'shitting', 'shithead', 'shitheads', 'bullshit',
  'cunt', 'cunts',
  'bitch', 'bitches', 'bitching',
  'asshole', 'assholes',
  'dickhead', 'dickheads',
  'bastard', 'bastards',
  'twat', 'twats',
  'wanker', 'wankers',
  'whore', 'whores',
  'slut', 'sluts',
  'kys',
  // slurs
  'nigger', 'niggers', 'nigga', 'niggas',
  'faggot', 'faggots', 'fag', 'fags',
  'retard', 'retards', 'retarded',
  'tranny', 'trannies',
  'dyke', 'dykes',
  'spic', 'spics',
  'chink', 'chinks',
  'kike', 'kikes',
  'gook', 'gooks',
  'wetback', 'wetbacks',
  'raghead', 'ragheads',
];

/** Matched inside any word ("motherfucker", "fuckin'"). Only roots no ordinary word contains. */
export const ROOTS = ['fuck'];
