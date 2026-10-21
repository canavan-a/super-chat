// The privacy policy, shown in the app (Settings, the welcome and lock
// screens) and as its own page on the web (/privacy). Keep it in step with
// the published copy, and update UPDATED when it changes.

export const UPDATED = '2026-10-20';
export const CONTACT = 'aidan@lunargen.com';

/** Inline **bold** is the only markup, in paragraphs, list items and table cells. */
export type PolicyBlock =
  | {p: string}
  | {list: string[]}
  | {table: {head: string[]; rows: string[][]}};

export interface PolicySection {
  title: string;
  blocks: PolicyBlock[];
}

export const POLICY: PolicySection[] = [
  {
    title: 'Summary',
    blocks: [
      {
        p: 'Super Chat collects no personal information and cannot read your messages. There are no accounts, no ads, no analytics and no tracking.',
      },
      {
        p: 'Everything you send is end-to-end encrypted on your device before it leaves it. Our server only relays and stores encrypted data it has no key for, under random identifiers that change from room to room. This policy describes exactly what that encrypted data is, how long it is kept, and the few outside services involved.',
      },
    ],
  },
  {
    title: 'What we never collect',
    blocks: [
      {p: 'Super Chat does not ask for, collect or store:'},
      {
        list: [
          'Your name, phone number, email address or any other identity',
          'Your contacts or address book',
          'Your location',
          'The content of your messages, files, pictures, voice calls, room names or display names (we only ever hold them encrypted)',
          'Analytics, usage statistics, crash reports or advertising identifiers',
          'Logs of who connects to the server: the server writes no request logs',
        ],
      },
      {
        p: 'We do not sell, rent or share data, because we have nothing readable to share.',
      },
    ],
  },
  {
    title: 'What our server stores',
    blocks: [
      {
        p: 'The server keeps only what it needs to deliver encrypted messages, and none of it is readable to us. You appear under a random member ID that is different in every room, so the server cannot tell that two rooms share a person.',
      },
      {
        table: {
          head: ['Data', 'What it is', 'Readable by us?'],
          rows: [
            [
              'Messages, reactions, read receipts',
              "Encrypted content, the sender's member ID, the room and the time sent",
              'No, only the time, room and member ID',
            ],
            [
              'Files and pictures (including profile pictures)',
              'Encrypted files',
              'No',
            ],
            [
              'Room log',
              'Signed records of who is in a room (member IDs), roles, invites, the retention setting and key changes; names and pictures inside it are encrypted',
              'Member IDs and roles only',
            ],
            [
              'Room keys',
              "Each room's key, encrypted separately to each member",
              'No',
            ],
            [
              'Room list backup',
              'An encrypted list of your rooms, stored under a random ID, so restoring from your recovery phrase finds them again',
              'No',
            ],
            [
              'Voice call setup',
              'Relayed between devices while a call starts, never stored',
              'No',
            ],
            [
              'IP addresses',
              'Held briefly in memory for rate limiting (to stop abuse), never written to disk',
              'Only while in memory',
            ],
          ],
        },
      },
      {
        p: 'Because we can see timing, sizes and random member IDs, we know that some member sent something to a room at a certain time, but not who you are or what was said.',
      },
    ],
  },
  {
    title: 'Outside services',
    blocks: [
      {
        p: 'A few outside services see limited technical data. None of them receive message content.',
      },
      {
        list: [
          '**Google Firebase Cloud Messaging (Google Play version and iPhone app).** To notify you while the app is closed, our server sends Google an empty wake-up for a room, with no message, sender or room name. Your device subscribes to rooms by a scrambled code, so our server never receives a device token. Google can see that your device was woken and when. On iPhone, Google passes the wake-up to the **Apple Push Notification service**, which shows the same fixed "New message" alert for every room, so Apple sees when a notification arrives, never what it is about. The version installed outside Google Play does not use Google services at all.',
          "**STUN and TURN servers (voice calls).** These help devices connect for voice. They see your IP address while you are in a call, never what is said, since calls are end-to-end encrypted. The app starts with Google's public STUN server, which you can remove; you choose any others in Settings → Voice.",
          '**People in your voice calls** may see your IP address unless you turn on "Relay all voice", which routes calls through a TURN relay.',
          "**Google Play** handles downloads and updates of the Google Play version under Google's own privacy policy.",
          "**The App Store** handles downloads and updates of the iPhone app under Apple's own privacy policy.",
        ],
      },
    ],
  },
  {
    title: 'Data on your device',
    blocks: [
      {
        p: 'Your account is a secret key that only ever exists on your devices. It is never sent to us.',
      },
      {
        list: [
          '**Android:** the key is kept in the Android Keystore, unlocked by your fingerprint or screen lock.',
          '**iPhone:** the key is kept in the iOS Keychain, only on this device, unlocked by Face ID or your passcode.',
          "**Web:** the key is kept in your browser's storage, encrypted with your passphrase.",
          '**Recovery phrase:** the 24 words shown at setup are the only way to restore your account. We cannot recover it for you.',
          '**Settings and caches:** your settings (including any STUN/TURN servers and their passwords) and copies of messages and pictures stay on the device. They are never synced to our server.',
        ],
      },
      {
        p: "The Android app blocks screenshots and hides its contents in the recent-apps screen. iOS doesn't let apps block screenshots.",
      },
    ],
  },
  {
    title: 'How long data is kept, and deleting it',
    blocks: [
      {
        list: [
          "**Retention:** each room's admins can set how many days messages are kept. Older encrypted messages and their files are deleted every hour. A room with no retention set keeps messages until they are deleted.",
          "**Deleting messages:** deleting a message removes it and its files from the server for everyone. An admin can also wipe a room's whole history.",
          '**Unused files:** an uploaded file that no message uses is deleted within an hour.',
          "**Leaving a room:** you stop receiving its messages, and the room's key is changed so you can't read anything new.",
          '**Your account:** there is nothing to delete on our side beyond the encrypted data above. Removing the app or choosing "Use a different account" erases your key from the device. (On iPhone, the key is erased the next time the app is installed, since iOS keeps it until then.) Without your recovery phrase, the encrypted data left on the server can never be read again.',
        ],
      },
    ],
  },
  {
    title: 'Reports',
    blocks: [
      {
        p: 'You can report a member or a room to us by email (see the Terms of use). A report contains only what you send: the app fills in the room and the member it is about, never any messages. We use reports only to remove rooms or members that break the terms.',
      },
    ],
  },
  {
    title: 'Children',
    blocks: [
      {
        p: "Super Chat is not directed at children under 13, and we don't knowingly collect anything from them; we don't collect personal information from anyone.",
      },
    ],
  },
  {
    title: 'Other servers',
    blocks: [
      {
        p: "This policy covers our server at chat.superbadger.io. Anyone can run their own Super Chat server; rooms on another server are subject to that server operator's practices, though messages stay end-to-end encrypted either way.",
      },
    ],
  },
  {
    title: 'Changes',
    blocks: [
      {
        p: "If this policy changes, we'll update the date at the top and describe the change in the app's release notes.",
      },
    ],
  },
  {
    title: 'Contact',
    blocks: [{p: `Questions about privacy: ${CONTACT}.`}],
  },
];
