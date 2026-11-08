// The content filter's built-in list (see wordFilter.ts): slurs and the most
// explicit swearing. Never shown in the app; it's used only when someone
// turns on "Filter slurs and profanity" in Settings → Content filter.
// Each entry matches as a whole word, ignoring case.

export const BUILT_IN_WORDS = [
  // swearing
  'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'fuckin',
  'motherfucker', 'motherfuckers', 'motherfucking',
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
