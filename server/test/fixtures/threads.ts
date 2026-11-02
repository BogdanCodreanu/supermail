import type { FakeThread } from '../fakes/fakeGmail.js';

/**
 * Real cases from the spec (§1), as fake Gmail threads. Dates are relative to `now` so `newer_than` and
 * `older_than` queries behave the same whenever the tests run.
 */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const FIXTURE_IDS = {
  bookstore: 'f-bookstore',
  googleSecurity: 'f-google-security',
  github: 'f-github',
  vercel: 'f-vercel',
  courseNewsletter: 'f-course-newsletter',
  bolt: 'f-bolt',
  personal: 'f-personal',
  alibaba: 'f-alibaba',
  archivedRecent: 'f-archived-recent',
  archivedOld: 'f-archived-old',
} as const;

/** Threads currently in the inbox. */
export function inboxFixtures(now: number): FakeThread[] {
  return [
    {
      id: FIXTURE_IDS.bookstore,
      messages: [{
        from: 'Libraria Cetatii <noreply@librariacetatii.example>',
        subject: 'Informare incident de securitate',
        snippet: 'Va informam ca a avut loc un incident de securitate',
        date: now - 2 * HOUR,
        listId: 'Libraria Cetatii Newsletter <newsletter.librariacetatii.example>',
        listUnsubscribe: '<mailto:unsubscribe@librariacetatii.example>',
        labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
      }],
    },
    {
      id: FIXTURE_IDS.googleSecurity,
      messages: [{
        from: 'Google <no-reply@accounts.google.com>',
        subject: 'Security alert',
        snippet: 'A new sign-in on Linux',
        date: now - 3 * HOUR,
        labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
      }],
    },
    {
      id: FIXTURE_IDS.github,
      messages: [{
        from: 'GitHub <notifications@github.com>',
        subject: '[owner/super-mail] CI failed on main',
        snippet: 'Run failed: test',
        date: now - 4 * HOUR,
        listId: 'owner/super-mail <super-mail.owner.github.com>',
        listUnsubscribe: '<https://github.com/notifications/unsubscribe>',
        labelIds: ['INBOX', 'CATEGORY_UPDATES'],
      }],
    },
    {
      id: FIXTURE_IDS.vercel,
      messages: [{
        from: 'Vercel <notifications@vercel.com>',
        subject: 'Failed production deployment on team',
        snippet: 'The deployment failed',
        date: now - 5 * HOUR,
        labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
      }],
    },
    {
      id: FIXTURE_IDS.courseNewsletter,
      messages: [{
        from: 'Școala de Weekend <hello@scoaladeweekend.example>',
        subject: 'Lectia de saptamana aceasta',
        snippet: 'Un nou modul este disponibil',
        date: now - 6 * HOUR,
        listUnsubscribe: '<https://scoaladeweekend.example/unsubscribe>',
        labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
      }],
    },
    {
      id: FIXTURE_IDS.bolt,
      messages: [{
        from: '"Bolt" <receipts@bolt.eu>',
        subject: 'Your Bolt Scooter ride',
        snippet: 'Thanks for riding with Bolt. Total 12.50 RON',
        date: now - 7 * HOUR,
        labelIds: ['INBOX', 'CATEGORY_UPDATES'],
        attachments: [{ filename: 'receipt.pdf', mimeType: 'application/pdf', data: '%PDF-1.4 fake' }],
      }],
    },
    {
      id: FIXTURE_IDS.personal,
      messages: [
        {
          from: 'Sam Carter <sam@carter.example>',
          subject: 'Coffee next week?',
          snippet: 'Are you around next week for a coffee?',
          date: now - 30 * HOUR,
          messageId: '<coffee-1@carter.example>',
          labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
        },
      ],
    },
    {
      id: FIXTURE_IDS.alibaba,
      messages: [{
        from: 'Alibaba.com <promo@notice.alibaba.com>',
        subject: 'Up to 70% off — Super September deals',
        snippet: 'Shop now',
        date: now - 8 * HOUR,
        listUnsubscribe: '<https://alibaba.com/unsub>',
        labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
      }],
    },
  ];
}

/** Archived threads: one inside the 90-day window, one older (reached only by backfill). */
export function archivedFixtures(now: number): FakeThread[] {
  return [
    {
      id: FIXTURE_IDS.archivedRecent,
      messages: [{ from: 'ING Bank <alerte@ing.ro>', subject: 'Extras de cont octombrie', date: now - 20 * DAY, labelIds: ['CATEGORY_UPDATES'] }],
    },
    {
      id: FIXTURE_IDS.archivedOld,
      messages: [{ from: 'Pensia Mea <office@pensiamea.example>', subject: 'Confirmare contributie pensie', date: now - 200 * DAY, labelIds: ['CATEGORY_UPDATES'] }],
    },
  ];
}

export function allFixtures(now: number): FakeThread[] {
  return [...inboxFixtures(now), ...archivedFixtures(now)];
}
