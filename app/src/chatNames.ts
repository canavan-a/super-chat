// Names for a chat started without one: an adjective and a noun ("Amber
// Otter"), so a new chat has something friendlier than "New chat" until
// someone renames it.

const ADJECTIVES = [
  'Amber', 'Azure', 'Brave', 'Breezy', 'Bright', 'Calm', 'Clever', 'Cosmic', 'Cozy', 'Crimson',
  'Curious', 'Dapper', 'Dusky', 'Electric', 'Fuzzy', 'Gentle', 'Golden', 'Happy', 'Hidden', 'Jolly',
  'Lucky', 'Lunar', 'Mellow', 'Misty', 'Mossy', 'Nimble', 'Noble', 'Quiet', 'Rapid', 'Rusty',
  'Silver', 'Sleepy', 'Snowy', 'Solar', 'Sunny', 'Swift', 'Tidy', 'Velvet', 'Wild', 'Witty',
];

const NOUNS = [
  'Badger', 'Beacon', 'Comet', 'Cove', 'Falcon', 'Fern', 'Fox', 'Garden', 'Harbor', 'Heron',
  'Island', 'Lantern', 'Lynx', 'Maple', 'Meadow', 'Moose', 'Moth', 'Nebula', 'Orchard', 'Otter',
  'Owl', 'Panda', 'Pebble', 'Pine', 'Planet', 'Puffin', 'Quokka', 'Raven', 'Reef', 'River',
  'Rocket', 'Sparrow', 'Summit', 'Teapot', 'Thistle', 'Tiger', 'Valley', 'Walrus', 'Willow', 'Yak',
];

const pick = (words: string[]) => words[Math.floor(Math.random() * words.length)];

export const randomChatName = (): string => `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
