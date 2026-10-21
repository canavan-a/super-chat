// The terms of use, shown in the app (Settings, the welcome screen) and as
// their own page on the web (/terms). Agreed to by continuing past the
// welcome screen. Keep them in step with the privacy policy (policy.ts), and
// update TERMS_UPDATED when they change.

import {CONTACT, type PolicySection} from './policy';

export const TERMS_UPDATED = '2026-10-20';

export const TERMS: PolicySection[] = [
  {
    title: 'Summary',
    blocks: [
      {
        p: "Super Chat is a free, end-to-end encrypted chat app made by Lunargen. By using it you agree to these terms. If you don't agree, please don't use the app.",
      },
    ],
  },
  {
    title: 'No tolerance for abuse',
    blocks: [
      {p: 'There is **zero tolerance** for objectionable content or abusive users. You may not use Super Chat to:'},
      {
        list: [
          'Share anything illegal, including any sexual content involving minors',
          'Threaten, harass, bully or stalk anyone',
          'Promote violence, terrorism or hatred against people',
          'Spread malware, scams or spam',
          "Pretend to be someone you aren't",
        ],
      },
    ],
  },
  {
    title: "What we can and can't see",
    blocks: [
      {
        p: "Messages, files and calls are end-to-end encrypted: we can't read them, and we can't tell who anyone is. We only ever see what someone chooses to send us in a report.",
      },
    ],
  },
  {
    title: 'Reporting and blocking',
    blocks: [
      {
        list: [
          'Report a member by tapping their profile picture in a chat, or use **Report abuse** in Settings.',
          'Block someone by tapping their profile picture: blocking leaves that room.',
          'Room admins can remove members, and anyone can leave a room at any time.',
        ],
      },
    ],
  },
  {
    title: 'What we do about reports',
    blocks: [
      {
        p: 'We review reports within 24 hours. When content or a member breaks these terms, we delete the room and its content from our server, or remove the member from the room.',
      },
    ],
  },
  {
    title: 'Your account',
    blocks: [
      {
        p: "Your account is a key kept on your device. You're responsible for keeping your recovery phrase or key file safe: we can't recover them, and anyone who has them can use your account.",
      },
    ],
  },
  {
    title: 'Other servers',
    blocks: [
      {
        p: 'Servers other than chat.superbadger.io are run by other people. These terms, and our handling of reports, only cover our server.',
      },
    ],
  },
  {
    title: 'No warranty',
    blocks: [
      {
        p: "Super Chat is provided as is, without warranty of any kind. To the extent the law allows, Lunargen isn't liable for any loss that comes from using it.",
      },
    ],
  },
  {
    title: 'Changes',
    blocks: [{p: 'We may update these terms. The date at the top shows when they last changed.'}],
  },
  {
    title: 'Contact',
    blocks: [{p: `Questions, or something to report: ${CONTACT}`}],
  },
];
