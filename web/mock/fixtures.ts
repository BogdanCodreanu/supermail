import type { AccountDTO, AddressDTO, AttachmentDTO, FilterDTO, GmailLabelDTO, GroupDTO, GroupReasonDTO, MessageDTO, ThreadId } from '@supermail/shared';
import { makePdf, makePng, svgDataUri } from './assets';

/**
 * The mock mailbox: two accounts and about 60 threads across the 7 starting groups, shaped like a typical personal and
 * work mailbox (spec §4.3–4.9, UX audit). Every person, company and address in it is fictional. Every time is relative to `now`, so the list always looks fresh.
 */

export interface MockThread {
  id: ThreadId;
  accountId: string;
  subject: string;
  fromName: string | null;
  fromEmail: string | null;
  listId: string | null;
  lastMessageAt: number;
  surfacedAt: number | null;
  unread: boolean;
  inInbox: boolean;
  groupId: string;
  reason: GroupReasonDTO;
  snoozedUntil: number | null;
  skipped: boolean;
  doneAt: number | null;
  suggestRule: boolean;
  messages: MessageDTO[];
}

export type MockGroup = Omit<GroupDTO, 'inboxCount' | 'unreadCount'>;

export interface MockWorld {
  me: string;
  accounts: AccountDTO[];
  groups: MockGroup[];
  threads: MockThread[];
  /** Gmail's spam, kept apart from `threads` the way the real server keeps it out of the index. */
  spam: MockThread[];
  labels: GmailLabelDTO[];
  filters: FilterDTO[];
  /** Attachment bytes by attachmentId. */
  blobs: Map<string, Uint8Array>;
  /** Next id for threads and messages created at runtime (incoming mail, sends). */
  seq: number;
}

export const ME = 'you@example.com';
export const OPS = 'work@example.com';
export const ACC_ME = 'a1f0c3e9b2d4';
export const ACC_OPS = 'c5e7a9b1d3f2';
export const UNSORTED_REASON = 'Unsorted: no confident match (automatic guess)';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** en-GB `d MMM`, the same as the server's reason dates. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function longDate(ms: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} at ${hm}`;
}

export const GROUPS: MockGroup[] = [
  { id: 'important', name: 'Important', position: 0, color: '#dc2626', notify: true, kind: 'builtin' },
  { id: 'money_security', name: 'Money & Security', position: 1, color: '#d97706', notify: true, kind: 'builtin' },
  { id: 'dev', name: 'Dev', position: 2, color: '#4f46e5', notify: true, kind: 'builtin' },
  { id: 'purchases', name: 'Purchases', position: 3, color: '#0891b2', notify: true, kind: 'builtin' },
  { id: 'news', name: 'News', position: 4, color: '#16a34a', notify: false, kind: 'builtin' },
  { id: 'low_priority', name: 'Low priority', position: 5, color: '#64748b', notify: false, kind: 'builtin' },
  { id: 'unsorted', name: 'Unsorted', position: 6, color: '#9333ea', notify: true, kind: 'builtin' },
];

type GroupKey = 'important' | 'money_security' | 'dev' | 'purchases' | 'news' | 'low_priority' | 'unsorted';
type Who = [name: string, email: string];
type AttachmentSpec = { filename: string; kind: 'pdf' | 'png'; lines?: string[] };
interface MessageSpec { from: Who | 'me'; ago: number; text?: string; html?: string; attachments?: AttachmentSpec[]; to?: AddressDTO[]; cc?: AddressDTO[] }

interface ThreadSpec {
  acc: 'me' | 'ops';
  group: GroupKey;
  from: Who;
  subject: string;
  /** How long ago the last message arrived. */
  ago: number;
  unread?: boolean;
  text?: string;
  html?: string;
  attachments?: AttachmentSpec[];
  /** The "why" of an automatic guess; a default is derived from the group and sender. */
  why?: string;
  /** A taught reason instead of a guess: when, and how. */
  taught?: { ago: number; source: 'override' | 'rule' | 'mark' };
  list?: string;
  /** A conversation; the last entry is the newest message. Overrides from/text/html. */
  messages?: MessageSpec[];
  snoozedFor?: number;
  skipped?: boolean;
  /** Marked Done this long ago. */
  doneAgo?: number;
  suggestRule?: boolean;
  cc?: AddressDTO[];
}

const groupName = (id: string) => GROUPS.find((g) => g.id === id)?.name ?? 'Unsorted';
const domainOf = (email: string) => email.slice(email.indexOf('@') + 1);

function guessedReason(s: ThreadSpec): GroupReasonDTO {
  if (s.group === 'unsorted') return { source: 'default', text: UNSORTED_REASON, at: null };
  const email = s.from[1];
  const why =
    s.why ??
    {
      important: `personal mail from ${email}`,
      money_security: `known money/security sender ${domainOf(email)}`,
      dev: `known dev sender ${domainOf(email)}`,
      purchases: 'mentions "receipt"',
      news: s.list ? `mailing list ${s.list}` : `newsletter from ${email}`,
      low_priority: 'Gmail category Promotions',
    }[s.group];
  return { source: 'heuristic', text: `In ${groupName(s.group)}: ${why} (automatic guess)`, at: null };
}

export function taughtReason(groupId: string, at: number, source: 'override' | 'rule' | 'mark'): GroupReasonDTO {
  return { source, text: `In ${groupName(groupId)} because you said so on ${shortDate(at)}`, at };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}

/** The snippet Gmail would show: the newest message's own text, without the quoted part. */
export function snippetOf(m: MessageDTO): string {
  const own = m.html ? htmlToText(m.html.split('<div class="gmail_quote"')[0]!) : (m.text ?? '');
  return own.replace(/\s+/g, ' ').trim().slice(0, 160);
}

// ---------------------------------------------------------------------------------------------------------------
// Bodies

const p = (s: string) => `<p style="margin:0 0 12px">${s}</p>`;

function quoted(reply: string, prev: { who: string; email: string; at: number; html: string }): string {
  return (
    `<div dir="ltr">${reply}</div><br>` +
    `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On ${longDate(prev.at)} ${prev.who} &lt;${prev.email}&gt; wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${prev.html}</blockquote></div>`
  );
}

function githubHtml(repo: string, title: string, body: string, url: string): string {
  return (
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2328">` +
    p(body) +
    `<p style="margin:16px 0 0;font-size:12px;color:#59636e">— <br>Reply to this email directly, <a href="${url}">view it on GitHub</a>, or ` +
    `<a href="https://github.com/notifications/unsubscribe">unsubscribe</a>.<br>You are receiving this because you are subscribed to ${repo}.</p>` +
    `<p style="display:none">${title}</p></div>`
  );
}

function vercelHtml(headline: string, project: string, detail: string, ok: boolean): string {
  return (
    `<table role="presentation" width="100%" style="font-family:Geist,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#171717">` +
    `<tr><td style="padding:24px 0 8px;font-size:20px;font-weight:600">${headline}</td></tr>` +
    `<tr><td style="padding:0 0 16px;font-size:14px;line-height:22px">${detail}</td></tr>` +
    `<tr><td style="padding:12px 16px;border:1px solid #eaeaea;border-radius:6px;font-size:13px">` +
    `<b>${project}</b> · Production · <span style="color:${ok ? '#0a7d33' : '#d93036'}">${ok ? 'Ready' : 'Error'}</span><br>` +
    `<span style="color:#666">main · a3f9c21 · “fix: header nav on mobile”</span></td></tr>` +
    `<tr><td style="padding:20px 0"><a href="https://vercel.com/examplestudio/${project}" style="background:#171717;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px">View ${ok ? 'deployment' : 'build logs'}</a></td></tr></table>`
  );
}

function boltReceipt(date: string, from: string, to: string, total: string): string {
  return (
    `<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;font-family:Helvetica,Arial,sans-serif;color:#2e2e2e">` +
    `<tr><td style="background:#34d186;padding:20px 24px;color:#fff;font-size:22px;font-weight:700">Bolt</td></tr>` +
    `<tr><td style="padding:24px"><div style="font-size:14px;color:#666">${date}</div>` +
    `<div style="font-size:28px;font-weight:700;margin:4px 0 16px">${total}</div>` +
    `<div style="font-size:14px;line-height:22px">From <b>${from}</b><br>To <b>${to}</b><br>Payment: Revolut •••• 4417</div>` +
    `<p style="font-size:12px;color:#888;margin-top:20px">The invoice is attached as a PDF. Thanks for riding with Bolt.</p></td></tr></table>`
  );
}

/** The wide newsletter (UX audit, larger change 3): a fixed 700px table with images, which must scale to fit. */
function weekendSchoolNewsletter(): string {
  const hero = svgDataUri(700, 260, '#1e3a5f', 'Cursurile din noiembrie');
  const card = (title: string, color: string, text: string, when: string) =>
    `<td width="334" valign="top" style="padding:0 8px 16px"><img src="${svgDataUri(334, 180, color, title)}" width="334" height="180" alt="${title}" style="display:block;border-radius:8px">` +
    `<h3 style="font-family:Georgia,serif;font-size:19px;margin:12px 0 6px;color:#1e293b">${title}</h3>` +
    `<p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:#475569;margin:0 0 6px">${text}</p>` +
    `<p style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#94a3b8;margin:0">${when}</p></td>`;
  return (
    `<table role="presentation" width="700" cellpadding="0" cellspacing="0" align="center" style="width:700px;background:#ffffff">` +
    `<tr><td style="padding:16px 24px;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#94a3b8">Nu vezi bine emailul? <a href="https://scoaladeweekend.example/newsletter/noiembrie">Deschide-l în browser</a></td></tr>` +
    `<tr><td><img src="${hero}" width="700" height="260" alt="Școala de Weekend — noiembrie" style="display:block"></td></tr>` +
    `<tr><td style="padding:28px 32px 8px;font-family:Georgia,serif;font-size:26px;color:#0f172a">Bună, Alex!</td></tr>` +
    `<tr><td style="padding:0 32px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:24px;color:#334155">` +
    `Noiembrie vine cu trei cursuri noi și un atelier de weekend. Locurile sunt limitate la 24 de participanți pe grupă, ca să rămână timp pentru fiecare întrebare.</td></tr>` +
    `<tr><td style="padding:0 8px"><table role="presentation" width="684" cellpadding="0" cellspacing="0"><tr>` +
    card('Scriere creativă', '#7c3aed', 'Opt întâlniri despre voce, ritm și cum termini ce ai început.', 'Marți, 19:00 · începe pe 4 noiembrie') +
    card('Public speaking', '#0f766e', 'Exerciții practice, filmate, cu feedback individual de la trainer.', 'Joi, 18:30 · începe pe 6 noiembrie') +
    `</tr><tr>` +
    card('Fotografie de stradă', '#b45309', 'Ieșiri în oraș cu un fotograf profesionist și analiză de portofoliu.', 'Sâmbătă, 10:00 · 3 ateliere') +
    card('Atelier: Focus profund', '#be123c', 'O zi întreagă despre atenție, rutine și cum îți protejezi timpul.', 'Duminică, 23 noiembrie') +
    `</tr></table></td></tr>` +
    `<tr><td align="center" style="padding:8px 32px 32px"><a href="https://scoaladeweekend.example/cursuri" style="display:inline-block;background:#1e3a5f;color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:15px;padding:14px 28px;border-radius:999px;text-decoration:none">Vezi toate cursurile</a></td></tr>` +
    `<tr><td style="padding:20px 32px;background:#f1f5f9;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:17px;color:#64748b">` +
    `Școala de Weekend SRL · Str. Exemplului 1, București<br>Primești acest email pentru că te-ai abonat pe scoaladeweekend.example. <a href="https://scoaladeweekend.example/dezabonare">Dezabonare</a></td></tr></table>`
  );
}

function slowBreathNewsletter(issue: number, title: string): string {
  const img = svgDataUri(600, 200, '#0e7490', `Issue ${issue}`);
  return (
    `<table role="presentation" width="600" align="center" style="width:600px;font-family:Georgia,serif;color:#1c1917;background:#fafaf9">` +
    `<tr><td><img src="${img}" width="600" height="200" alt="" style="display:block"></td></tr>` +
    `<tr><td style="padding:28px 36px 4px;font-size:24px">${title}</td></tr>` +
    `<tr><td style="padding:12px 36px;font-size:16px;line-height:26px">` +
    p('Sit somewhere you can put both feet flat on the floor. Breathe in through the nose for four counts, hold for seven, and let the air out through the mouth for eight.') +
    p('Four rounds is enough. If you feel light-headed, go back to normal breathing; the pattern works because it slows you down, not because you push.') +
    p('This week we also answer your questions about breathing before sleep, and why the long exhale matters more than the count.') +
    `</td></tr><tr><td style="padding:8px 36px 32px"><a href="https://slowbreath.example/practice/478" style="color:#0e7490">Start the 6-minute guided session →</a></td></tr>` +
    `<tr><td style="padding:16px 36px;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#78716c">Slow Breath Weekly · You signed up at slowbreath.example · <a href="https://slowbreath.example/unsubscribe">Unsubscribe</a></td></tr></table>`
  );
}

function alibabaPromo(headline: string, sub: string): string {
  const banner = svgDataUri(640, 180, '#ff6a00', headline);
  return (
    `<table role="presentation" width="640" align="center" style="width:640px;font-family:Arial,sans-serif;background:#fff">` +
    `<tr><td><img src="${banner}" width="640" height="180" alt="${headline}" style="display:block"></td></tr>` +
    `<tr><td style="padding:20px 24px;font-size:15px;color:#333">${sub}</td></tr>` +
    `<tr><td style="padding:0 24px 24px"><a href="https://www.alibaba.com/promotion" style="background:#ff6a00;color:#fff;padding:12px 22px;text-decoration:none;border-radius:4px">Shop now</a></td></tr>` +
    `<tr><td style="padding:12px 24px;font-size:11px;color:#999">Alibaba.com · You are receiving this email because you registered on Alibaba.com. Unsubscribe</td></tr></table>`
  );
}

/** The very long plain-text email (UX audit: reading). */
function publisherMeetingNotes(): string {
  const sections: [string, string[]][] = [
    ['Context', [
      'We met the publisher for almost three hours on Tuesday. I am writing everything down while it is fresh, because a lot of it changes the plan for the next two milestones and I do not want us to argue later about who said what.',
      'Present: Dan, Nora from their production team, their new BD lead (Tom), and me. Paul joined for the last half hour to talk about audio.',
    ]],
    ['Milestone 3 (vertical slice)', [
      'They are happy with the slice overall. The heist planning phase landed well, the hand interactions less so. Tom played for twenty minutes and twice lost the lockpick because the grab radius is too small on Quest 3. That matches issue #198 and the jitter PR, so we should get #212 merged this week.',
      'They want the tutorial cut in half. Right now it takes six minutes before you touch anything interesting. Their data says most refunds on VR titles happen in the first fifteen minutes, so anything that delays the first "wow" costs money.',
      'Performance: they measured 68 to 72 fps in the vault level with the volumetric lights on. The target is a locked 72 on Quest 3 and 90 on PC VR. They are fine with us dropping the volumetrics on Quest if needed.',
    ]],
    ['Money', [
      'The milestone 3 payment is approved and should arrive within 30 days of the invoice. Please send the invoice to their finance address, not to Tom. Contabil Exemplu needs the signed acceptance form for the books, so I will forward it as soon as it arrives.',
      'They asked whether we could bring milestone 4 forward by three weeks. I said not without cutting scope. They will come back with a proposal; my guess is they want something playable for a February showcase.',
    ]],
    ['Marketing', [
      'Steam page: they want the new capsule art before Next Fest sign-up closes. Dan has the copy almost done. They liked the second trailer cut but want the first five seconds to show hands, not the city skyline.',
      'They will pay for two influencer previews in January. We need a build that does not crash in level 4 by then, see the crash issue.',
    ]],
    ['Audio', [
      'Paul walked them through the adaptive music system. They loved the idea that the music thins out when the guard is close. The licensing question for the jazz samples is still open; Paul will send the contract to Nora by Friday.',
    ]],
    ['Risks we discussed openly', [
      'The biggest one is our team size. If one of us is sick for two weeks, the milestone slips. They offered a contractor from their pool for QA, which I think we should accept.',
      'Second, the Quest store review. They have seen titles rejected for comfort ratings. We should run the comfort checklist on the slice before we submit anything.',
      'Third, scope creep from their side. Every meeting adds "small" requests. I asked that every change request comes in writing with a date, and they agreed.',
    ]],
  ];
  const actions = [
    'Merge the hand tracking jitter fix (PR #212) and cut a new build for Tom.',
    'Halve the tutorial: move the lockpick lesson into the first heist.',
    'Profile the vault level on Quest 3 with volumetrics off.',
    'Send the milestone 3 invoice to the publisher finance address.',
    'Forward the signed acceptance form to Contabil Exemplu.',
    'Finish the Steam page copy and the new capsule art.',
    'Recut the first five seconds of the trailer around the hands.',
    'Fix the level 4 crash before the influencer builds.',
    'Send the jazz sample contract to Nora by Friday.',
    'Accept the QA contractor and set up their access.',
    'Run the comfort checklist on the vertical slice.',
    'Write a one-page change request template for the publisher.',
  ];
  let out = 'Hi both,\n\nLong one, sorry. Notes from the publisher meeting, then action items at the end.\n\n';
  for (const [title, paras] of sections) out += `${title.toUpperCase()}\n${'-'.repeat(title.length)}\n\n${paras.join('\n\n')}\n\n`;
  out += 'ACTION ITEMS\n------------\n\n';
  actions.forEach((a, i) => (out += `${String(i + 1).padStart(2, ' ')}. ${a}\n`));
  out += '\nAppendix: their exact notes on each level, copied from the shared doc\n\n';
  for (let level = 1; level <= 6; level++) {
    out += `Level ${level}\n`;
    out += `  - First impression: ${['strong', 'good', 'mixed', 'too long', 'confusing in the middle', 'great ending'][level - 1]}.\n`;
    out += `  - Frame rate: ${70 + (level % 3)} fps average on Quest 3, ${level === 4 ? 'one crash on load' : 'no crashes'}.\n`;
    out += '  - Hands: the grab radius feels small; the drawers in the office are hard to open.\n';
    out += '  - Audio: the guard footsteps are too quiet compared to the music.\n';
    out += '  - Suggestion: add a short line from the handler when the player has been stuck for more than a minute.\n\n';
  }
  out += 'That is everything. Shout if I got something wrong.\n\nSam\n';
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The mailbox

const sam: Who = ['Sam Carter', 'sam_carter@gmail.com'];
const irina: Who = ['Irina Vasile', 'irina.vasile@example.org'];
const github: Who = ['GitHub', 'notifications@github.com'];
const vercel: Who = ['Vercel', 'notifications@vercel.com'];
const google: Who = ['Google', 'no-reply@accounts.google.com'];
const ing: Who = ['ING Bank', 'notificari@ing.ro'];
const revolut: Who = ['Revolut', 'no-reply@revolut.com'];
const bolt: Who = ['Bolt', 'receipts@bolt.eu'];
const alibaba: Who = ['Alibaba.com', 'promotion@service.alibaba.com'];
const school: Who = ['Școala de Weekend', 'hello@scoaladeweekend.example'];
const breath: Who = ['Slow Breath Weekly', 'newsletter@slowbreath.example'];
const accountant: Who = ['Contabil Exemplu', 'office@contabil.example'];

function specs(): ThreadSpec[] {
  const m = MIN;
  const h = HOUR;
  const d = DAY;
  const weekend1 = 'Salut! Ce zici de un weekend la Brașov pe 8–9 noiembrie? Am găsit o cabană lângă Poiana, 4 camere, cu șemineu. Ar veni și Irina cu Radu.';
  return [
    // ---- Important
    {
      acc: 'me', group: 'important', from: sam, subject: 'Weekend la Brașov?', ago: 14 * m, unread: true,
      taught: { ago: 1 * d, source: 'mark' },
      messages: [
        { from: sam, ago: 2 * d + 3 * h, html: `<div dir="ltr">${weekend1}</div>` },
        { from: 'me', ago: 2 * d, html: 'q1' },
        { from: sam, ago: 1 * d + 5 * h, html: 'q2' },
        { from: sam, ago: 14 * m, html: 'q3' },
      ],
    },
    {
      acc: 'me', group: 'important', from: irina, subject: 'Photos from Sunday', ago: 2 * h, unread: true,
      text: 'Hi Alex,\n\nHere is the one from the lake I promised. The rest are in the shared album, but this one came out really well, so I wanted you to have it in full size.\n\nSee you Thursday?\nIrina',
      attachments: [{ filename: 'IMG_2041.png', kind: 'png' }],
    },
    {
      acc: 'me', group: 'important', from: irina, subject: 'Contract chirie — draft pentru noiembrie', ago: 1 * d + 2 * h,
      text: 'Bună,\n\nȚi-am atașat mai jos ce am discutat cu proprietarul. Chiria rămâne 2.300 lei, dar vrea garanția pe două luni. Mi se pare corect, tu ce zici?\n\nTe rog să te uiți până joi, că atunci semnăm.\n\nMulțumesc,\nIrina',
    },
    {
      acc: 'ops', group: 'important', from: sam, subject: 'Call tomorrow about the playtest build?', ago: 47 * m, unread: true,
      text: 'Hey, can we do 30 minutes tomorrow at 11? I want to go through the playtest feedback before we send the build to Tom. Mostly the lockpick and the tutorial length.\n\nV.',
      taught: { ago: 1 * d, source: 'rule' },
    },
    {
      acc: 'ops', group: 'important', from: sam, subject: 'Notes from the publisher meeting (long)', ago: 5 * h, unread: true,
      text: publisherMeetingNotes(), cc: [{ name: 'Dan Marin', email: 'dan@example.com' }],
      taught: { ago: 1 * d, source: 'rule' },
    },
    {
      acc: 'ops', group: 'important', from: ['Dan Marin', 'dan@example.com'], subject: 'Steam page copy — final pass', ago: 9 * h,
      text: 'Here is the final pass on the Steam copy. I cut the second paragraph and moved the co-op line up, because that is what people ask about first.\n\nShort description (300 chars max):\n"Plan the perfect heist with your hands. Pick locks, crack safes and talk your way past guards in a noir city built for VR."\n\nLet me know by Friday if you want changes.\nDan',
    },
    {
      acc: 'me', group: 'important', from: ['Carmen Stoica', 'carmen.stoica@example.net'], subject: 'Invitație la nuntă — 14 iunie 2027', ago: 3 * d,
      text: 'Dragă Alex,\n\nNe căsătorim! Ne-ar bucura enorm să fii alături de noi pe 14 iunie 2027, la Conacul Bellu. Te rugăm să ne confirmi până la 1 martie dacă vii și dacă aduci pe cineva.\n\nCu drag,\nCarmen și Matei',
    },
    {
      acc: 'ops', group: 'important', from: ['Paul Radu', 'paul@soundstudio.example'], subject: 'Re: Trailer music — two options', ago: 2 * d + 4 * h,
      messages: [
        { from: 'me', ago: 3 * d, html: '<div dir="ltr">Hi Paul, can you send two options for the trailer? One tense, one more playful. 60 seconds each is plenty.</div>' },
        { from: ['Paul Radu', 'paul@soundstudio.example'], ago: 2 * d + 4 * h, html: 'q-paul' },
      ],
    },

    // ---- Money & Security
    {
      acc: 'me', group: 'money_security', from: google, subject: 'Security alert: new sign-in on Linux', ago: 31 * m, unread: true,
      html:
        `<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;font-family:Roboto,Arial,sans-serif;border:1px solid #dadce0;border-radius:8px">` +
        `<tr><td style="padding:24px;text-align:center;font-size:22px;color:#202124">A new sign-in on Linux</td></tr>` +
        `<tr><td style="padding:0 24px 8px;text-align:center;font-size:14px;color:#3c4043">${ME}</td></tr>` +
        `<tr><td style="padding:16px 24px;font-size:14px;line-height:20px;color:#3c4043">We noticed a new sign-in to your Google Account on a Linux device. If this was you, you don’t need to do anything. If not, we’ll help you secure your account.</td></tr>` +
        `<tr><td style="padding:8px 24px 24px;text-align:center"><a href="https://myaccount.google.com/notifications" style="background:#1a73e8;color:#fff;padding:10px 24px;border-radius:4px;text-decoration:none;font-size:14px">Check activity</a></td></tr></table>`,
    },
    {
      acc: 'ops', group: 'money_security', from: google, subject: 'Security alert for work@example.com', ago: 1 * d + 7 * h,
      text: `App password created\n\nAn app password was created for ${OPS} to sign in to "Thunderbird on Linux". If you didn't generate this password, someone might be using your account.\n\nCheck activity: https://myaccount.google.com/notifications\n\nYou received this email to let you know about important changes to your Google Account and services.\n© 2026 Google LLC`,
    },
    {
      acc: 'me', group: 'money_security', from: ing, subject: 'Ai primit o plată de 4.250,00 RON', ago: 3 * h, unread: true,
      text: 'Bună, Alex!\n\nContul tău RO49 INGB 0000 9999 0123 4567 a fost creditat cu 4.250,00 RON.\nPlătitor: EXAMPLE STUDIO SRL\nDetalii: Dividende T3 2026\n\nSold disponibil: 18.904,12 RON\n\nING Bank N.V. Amsterdam – Sucursala București',
    },
    {
      acc: 'me', group: 'money_security', from: ing, subject: 'Extrasul de cont pentru octombrie este disponibil', ago: 2 * d + 1 * h,
      text: 'Extrasul de cont pentru luna octombrie 2026 este disponibil în Home\'Bank, la secțiunea Documente.\n\nDin motive de securitate nu îl atașăm la email.\n\nEchipa ING',
    },
    {
      acc: 'me', group: 'money_security', from: revolut, subject: 'Your October statement is ready', ago: 20 * h,
      text: 'Hi Alex,\n\nYour EUR account statement for October 2026 is attached.\n\nOpening balance: €2,184.50\nClosing balance: €1,962.07\n\nYou can also find it in the app under Accounts → Statements.\n\nRevolut',
      attachments: [{ filename: 'Revolut-statement-Oct-2026.pdf', kind: 'pdf', lines: ['Revolut Bank UAB', 'Account statement: EUR', 'October 2026', '', 'Opening balance  EUR 2,184.50', 'Closing balance  EUR 1,962.07'] }],
    },
    {
      acc: 'me', group: 'money_security', from: revolut, subject: 'You received €120.00 from Paul Radu', ago: 2 * d + 9 * h,
      text: 'Paul Radu sent you €120.00.\nNote: "cabana + benzina"\n\nIt is already in your EUR account.',
    },
    {
      acc: 'ops', group: 'money_security', from: accountant, subject: 'Documente lunare octombrie — Example Studio SRL', ago: 6 * h, unread: true,
      taught: { ago: 1 * d, source: 'rule' },
      text: 'Bună ziua,\n\nVă transmitem balanța de verificare pentru octombrie și chitanța pentru plata onorariului. Vă rugăm să ne trimiteți până pe 10 noiembrie extrasele de cont și facturile de achiziție lipsă (Steam, Unity, Vercel).\n\nCu stimă,\nLaura Neagu\nContabil Exemplu SRL\nTel. 0700 000 000',
      attachments: [
        { filename: 'Balanta-verificare-octombrie-2026.pdf', kind: 'pdf', lines: ['EXAMPLE STUDIO SRL', 'Balanta de verificare', 'Octombrie 2026', '', 'Total sume debitoare  412.380,55', 'Total sume creditoare 412.380,55'] },
        { filename: 'Chitanta-onorariu-oct.png', kind: 'png' },
      ],
    },
    {
      acc: 'ops', group: 'money_security', from: accountant, subject: 'Reminder: declarația D300 se depune până pe 25', ago: 4 * d,
      taught: { ago: 1 * d, source: 'rule' },
      text: 'Bună ziua,\n\nVă reamintim că declarația D300 (TVA) pentru octombrie se depune până pe 25 noiembrie. Avem nevoie de facturile de vânzare până pe 15.\n\nCu stimă,\nContabil Exemplu',
    },
    {
      acc: 'ops', group: 'money_security', from: ['Google Payments', 'payments-noreply@google.com'], subject: 'Your Google Play payout of $1,284.20 is on its way', ago: 3 * d + 6 * h,
      text: 'Your earnings for September have been sent to the bank account ending in 0042. Funds usually arrive within 3–5 business days.',
    },

    // ---- Dev
    {
      acc: 'ops', group: 'dev', from: github, subject: '[examplestudio/heist-game] Fix hand tracking jitter on Quest 3 (PR #212)', ago: 22 * m, unread: true,
      list: 'heist-game.examplestudio.github.com', taught: { ago: 1 * d, source: 'rule' },
      html: githubHtml('examplestudio/heist-game', 'PR #212', '<b>@dan-marin</b> requested your review on this pull request.<br><br>Smooths the wrist pose with a one-euro filter and widens the grab radius from 4 cm to 6 cm on Quest 3. Fixes #198.<br><br><code>3 files changed, +84 −21</code>', 'https://github.com/examplestudio/heist-game/pull/212'),
    },
    {
      acc: 'me', group: 'dev', from: github, subject: '[alex-example/supermail] Run failed: CI - main (617c34f)', ago: 1 * h + 10 * m, unread: true,
      list: 'supermail.alex-example.github.com',
      html: githubHtml('alex-example/supermail', 'CI', 'The <b>CI</b> workflow run failed for main.<br><br>✗ typecheck — web/src/views/Thread.tsx(57,18): error TS2322<br>✓ test (52s)<br>✓ build (31s)', 'https://github.com/alex-example/supermail/actions'),
    },
    {
      acc: 'ops', group: 'dev', from: github, subject: 'Re: [examplestudio/heist-game] Crash when loading level 4 (Issue #198)', ago: 7 * h,
      list: 'heist-game.examplestudio.github.com', taught: { ago: 1 * d, source: 'rule' },
      html: githubHtml('examplestudio/heist-game', 'Issue #198', '<b>@sam-carter</b> commented:<br><br>Repro on Quest 3 with build 0.8.14: load level 4 from the menu, crash after about 3 s. Logcat shows an OOM in the lightmap streamer. It does not happen when you reach level 4 by playing through.', 'https://github.com/examplestudio/heist-game/issues/198'),
    },
    {
      acc: 'me', group: 'dev', from: github, subject: '[GitHub] A third-party OAuth application has been added to your account', ago: 1 * d + 3 * h,
      text: 'Hey alex-example!\n\nA third-party OAuth application (Vercel) with read:user, repo and workflow scopes was recently authorized to access your account.\n\nVisit https://github.com/settings/connections/applications for more information.\n\nThanks,\nThe GitHub Team',
    },
    {
      acc: 'ops', group: 'dev', from: github, subject: '[examplestudio/website] Bump next from 15.1.0 to 15.1.6 (PR #57)', ago: 2 * d + 2 * h,
      list: 'website.examplestudio.github.com', taught: { ago: 1 * d, source: 'rule' },
      html: githubHtml('examplestudio/website', 'PR #57', 'Bumps <a href="https://github.com/vercel/next.js">next</a> from 15.1.0 to 15.1.6.<br><br>Release notes: security fix for middleware authorization bypass.', 'https://github.com/examplestudio/website/pull/57'),
    },
    {
      acc: 'ops', group: 'dev', from: vercel, subject: 'Failed production deployment on examplestudio-website', ago: 4 * h, unread: true,
      html: vercelHtml('Your deployment failed', 'examplestudio-website', 'The build step exited with code 1: <code>Type error: Property \'locale\' does not exist on type \'Params\'.</code>', false),
    },
    {
      acc: 'me', group: 'dev', from: vercel, subject: 'Deployment ready: portfolio-site', ago: 1 * d + 9 * h,
      html: vercelHtml('Your deployment is ready', 'portfolio-site', 'Production is now serving the latest commit.', true),
    },
    {
      acc: 'ops', group: 'dev', from: vercel, subject: 'You have used 82% of your bandwidth this month', ago: 3 * d + 2 * h,
      text: 'Your team Example Studio has used 82 GB of the 100 GB Fast Data Transfer included this month. The usage resets on 1 November.\n\nView usage: https://vercel.com/examplestudio/~/usage',
    },
    {
      acc: 'me', group: 'dev', from: github, subject: '[alex-example/supermail] Run failed: deploy - main (692c891)', ago: 2 * d + 6 * h,
      list: 'supermail.alex-example.github.com',
      html: githubHtml('alex-example/supermail', 'deploy', 'The <b>deploy</b> workflow run failed for main.<br><br>✗ build add-on image — COPY failed: file not found in build context: web/dist', 'https://github.com/alex-example/supermail/actions'),
    },
    {
      acc: 'ops', group: 'dev', from: ['Unity', 'no-reply@unity3d.com'], subject: 'Unity 6.2 LTS is here', ago: 5 * d, why: 'known dev sender unity3d.com',
      text: 'Unity 6.2 LTS brings faster Android builds, the new Quest 3 render path and two years of support. Read the release notes at unity.com/releases.',
    },

    // ---- Purchases
    {
      acc: 'me', group: 'purchases', from: bolt, subject: 'Your Bolt trip on Tuesday', ago: 1 * h + 40 * m, unread: true,
      html: boltReceipt('Tue, 29 Oct 2026, 08:42', 'Str. Exemplului 10', 'Piața Victoriei 1', '23,40 lei'),
      attachments: [{ filename: 'Bolt-receipt-2026-10-29.pdf', kind: 'pdf', lines: ['Bolt Operations OU', 'Ride receipt', '29 Oct 2026, 08:42', '', 'Total 23,40 lei'] }],
    },
    {
      acc: 'me', group: 'purchases', from: bolt, subject: 'Your Bolt trip on Monday', ago: 1 * d + 11 * h,
      html: boltReceipt('Mon, 28 Oct 2026, 22:15', 'Strada Fictivă 6', 'Str. Exemplului 10', '31,90 lei'),
      attachments: [{ filename: 'Bolt-receipt-2026-10-28.pdf', kind: 'pdf', lines: ['Bolt Operations OU', 'Ride receipt', '28 Oct 2026, 22:15', '', 'Total 31,90 lei'] }],
      taught: { ago: 2 * d, source: 'override' }, suggestRule: true,
    },
    {
      acc: 'me', group: 'purchases', from: bolt, subject: 'Your Bolt trip on Saturday', ago: 3 * d + 14 * h,
      html: boltReceipt('Sat, 26 Oct 2026, 19:03', 'Aeroportul Otopeni', 'Str. Exemplului 10', '78,10 lei'),
      attachments: [{ filename: 'Bolt-receipt-2026-10-26.pdf', kind: 'pdf', lines: ['Bolt Operations OU', 'Ride receipt', '26 Oct 2026, 19:03', '', 'Total 78,10 lei'] }],
    },
    {
      acc: 'ops', group: 'purchases', from: bolt, subject: 'Your Bolt Business trip on Friday', ago: 4 * d + 3 * h, why: 'mentions "trip"',
      html: boltReceipt('Fri, 25 Oct 2026, 09:20', 'Str. Exemplului 10', 'Strada Atelierului 5', '27,60 lei'),
      attachments: [{ filename: 'Bolt-Business-invoice-2026-10-25.pdf', kind: 'pdf', lines: ['Bolt Operations OU', 'Business ride invoice', 'EXAMPLE STUDIO SRL', '25 Oct 2026, 09:20', '', 'Total 27,60 lei'] }],
    },
    {
      acc: 'me', group: 'purchases', from: ['eMAG', 'comenzi@emag.ro'], subject: 'Comanda ta nr. 48213977 a fost livrată', ago: 1 * d + 6 * h, why: 'mentions "comanda"',
      text: 'Salut, Alex!\n\nComanda nr. 48213977 a fost livrată la easybox Exemplului.\n\n1 x Căști Sony WH-1000XM6 — 1.799,99 lei\n\nPoți ridica coletul în următoarele 48 de ore.',
    },
    {
      acc: 'me', group: 'purchases', from: ['Amazon.de', 'versandbestaetigung@amazon.de'], subject: 'Your Amazon.de order of "Anker USB-C hub" has been dispatched', ago: 2 * d + 8 * h, why: 'mentions "order"',
      text: 'Hello Alex,\n\nYour package is on its way. Estimated delivery: Monday 3 November.\n\nOrder #302-7781934-1182730\nAnker 7-in-1 USB-C hub — €39.99',
    },
    {
      acc: 'ops', group: 'purchases', from: ['Steam', 'noreply@steampowered.com'], subject: 'Thank you for your Steam purchase!', ago: 5 * d + 2 * h, why: 'mentions "purchase"',
      text: 'Thank you for your recent transaction on Steam.\n\nSteam Direct Product Submission Fee — $100.00\nPayment method: Visa •••• 0042\n\nAccount name: examplestudio',
    },

    // ---- News
    {
      acc: 'me', group: 'news', from: school, subject: 'Cursurile din noiembrie: scriere, public speaking și un atelier de focus', ago: 4 * h + 20 * m, unread: true,
      list: 'newsletter.scoaladeweekend.example', html: weekendSchoolNewsletter(),
    },
    {
      acc: 'me', group: 'news', from: school, subject: 'Ultimele 3 locuri la atelierul de scriere', ago: 6 * d,
      list: 'newsletter.scoaladeweekend.example',
      html: `<div style="font-family:Georgia,serif;font-size:16px;line-height:26px;max-width:560px;margin:0 auto">${p('Bună, Alex!')}${p('Au mai rămas doar trei locuri la atelierul de scriere creativă din noiembrie. Dacă te gândeai să vii, acum e momentul.')}${p('<a href="https://scoaladeweekend.example/scriere">Rezervă-ți locul</a>')}</div>`,
    },
    {
      acc: 'me', group: 'news', from: breath, subject: 'Slow Breath #42 — the 4-7-8 reset', ago: 18 * h,
      list: 'weekly.slowbreath.example', html: slowBreathNewsletter(42, 'The 4-7-8 reset'),
    },
    {
      acc: 'me', group: 'news', from: breath, subject: 'Slow Breath #41 — breathing before sleep', ago: 7 * d + 1 * h,
      list: 'weekly.slowbreath.example', html: slowBreathNewsletter(41, 'Breathing before sleep'),
    },
    {
      acc: 'me', group: 'news', from: ['TLDR Dev', 'hi@tldrnewsletter.com'], subject: 'Bun 2.0, Postgres 19 beta, writing a tiny SSE server 📬', ago: 9 * h,
      list: 'tldr-dev.tldrnewsletter.com',
      text: 'TLDR Dev 2026-10-29\n\nBIG TECH & STARTUPS\nBun 2.0 ships with a built-in S3 client and a 30% faster bundler (4 minute read)\n\nPROGRAMMING\nPostgres 19 beta: what changes for JSON (7 minute read)\nWriting a tiny SSE server in 80 lines (5 minute read)\n\nMISCELLANEOUS\nWhy your keyboard shortcuts feel slow (6 minute read)',
    },
    {
      acc: 'ops', group: 'news', from: ['Game Developer', 'newsletters@gamedeveloper.com'], subject: 'This week: VR retention numbers nobody wants to talk about', ago: 2 * d + 11 * h,
      list: 'gamedev-weekly.gamedeveloper.com',
      text: 'The share of VR players who come back on day 7 fell again this year. We talked to five studios about what still works: short sessions, social hooks, and tutorials under two minutes.',
    },

    // ---- Low priority
    {
      acc: 'ops', group: 'low_priority', from: alibaba, subject: 'Up to 70% off: 11.11 early deals for your business', ago: 2 * h + 30 * m, unread: true,
      html: alibabaPromo('11.11 early deals', 'Save up to 70% on VR accessories, controllers and charging docks from verified suppliers.'),
    },
    {
      acc: 'ops', group: 'low_priority', from: alibaba, subject: 'Your exclusive $20 coupon expires tonight', ago: 1 * d + 1 * h, taught: { ago: 1 * d, source: 'mark' },
      html: alibabaPromo('Coupon: $20 off', 'Use it on any order over $200 before midnight (PST).'),
    },
    {
      acc: 'ops', group: 'low_priority', from: alibaba, subject: 'Top-ranking products in Consumer Electronics', ago: 3 * d + 4 * h, taught: { ago: 1 * d, source: 'mark' },
      html: alibabaPromo('Top-ranking products', 'The suppliers buyers trusted most this month.'),
    },
    {
      acc: 'ops', group: 'low_priority', from: alibaba, subject: 'Re: Inquiry about Quest 3 head strap (MOQ 500)', ago: 6 * d, taught: { ago: 1 * d, source: 'mark' },
      text: 'Dear friend,\n\nThank you for your inquiry. Our MOQ is 500 pcs, price USD 3.80/pc FOB Shenzhen. Logo printing is available. Please check our new catalogue.\n\nBest regards,\nCindy',
    },
    {
      acc: 'me', group: 'low_priority', from: ['LinkedIn', 'messages-noreply@linkedin.com'], subject: 'You appeared in 14 searches this week', ago: 1 * d + 4 * h, why: 'Gmail category Social',
      text: 'Alex, you appeared in 14 searches this week. See who is looking at your profile.',
    },
    {
      acc: 'me', group: 'low_priority', from: ['Glovo', 'noreply@glovoapp.com'], subject: 'Transport gratuit la prima comandă din weekend 🍕', ago: 2 * d + 5 * h,
      text: 'Weekend leneș? Ai transport gratuit la prima comandă de sâmbătă și duminică, la peste 300 de restaurante.',
    },

    // ---- Unsorted
    {
      acc: 'ops', group: 'unsorted', from: ['Unity Billing', 'billing@unity.com'], subject: 'Your Unity Pro seat renews on 12 November', ago: 11 * h, unread: true,
      text: 'Your Unity Pro subscription (1 seat) renews on 12 November 2026 for $2,200.00. No action is needed if your payment details are up to date.',
    },
    {
      acc: 'me', group: 'unsorted', from: ['Bucharest XR Meetup', 'meetup@xrmeetup.example'], subject: 'Meetup în noiembrie: hand tracking în practică', ago: 1 * d + 8 * h,
      text: 'Salutare! Următorul meetup este joi, 13 noiembrie, la 19:00, la hub-ul din centru. Vorbim despre hand tracking în practică, cu demo-uri pe Quest 3. Intrarea e liberă, dar te rugăm să te înscrii.',
    },
    {
      acc: 'me', group: 'unsorted', from: ['Notion', 'notify@makenotion.com'], subject: 'Your workspace export is ready', ago: 2 * d + 3 * h,
      text: 'The export of "Example Studio" you requested is ready. The download link expires in 7 days.',
    },
    {
      acc: 'ops', group: 'unsorted', from: ['Tom Walsh', 'tom.walsh@publisher.example'], subject: 'Milestone 4 — revised dates', ago: 3 * h + 15 * m, unread: true,
      text: 'Hi both,\n\nFollowing Tuesday, here is our proposal: milestone 4 moves to 30 January, with the co-op mode moved to milestone 5. I have attached nothing yet; the formal change request will follow from Nora.\n\nBest,\nTom',
    },
    {
      acc: 'me', group: 'unsorted', from: ['Booking.com', 'noreply@booking.com'], subject: 'Mai e timp: prețuri bune la Brașov în noiembrie', ago: 4 * d + 6 * h,
      text: 'Ai căutat recent cazare la Brașov. Uite câteva oferte pentru 8–9 noiembrie.',
    },

    // ---- Snoozed (out of the inbox until the snooze is due)
    {
      acc: 'me', group: 'important', from: ['RAR', 'programari@rarom.ro'], subject: 'Programare ITP confirmată — 12 noiembrie, 09:30', ago: 2 * d, snoozedFor: 20 * h, why: 'personal mail from programari@rarom.ro',
      text: 'Programarea dumneavoastră pentru inspecția tehnică periodică a fost confirmată: 12 noiembrie 2026, ora 09:30, RAR Sector 1.',
    },
    {
      acc: 'me', group: 'money_security', from: revolut, subject: 'Your card ending 4417 expires next month', ago: 3 * d, snoozedFor: 6 * d,
      text: 'Your Revolut card ending 4417 expires at the end of November. We will send a new one to your address; it should arrive within 7 days.',
    },
    {
      acc: 'ops', group: 'dev', from: github, subject: '[examplestudio/heist-game] Review requested: Lightmap streaming budget (PR #219)', ago: 5 * h, snoozedFor: 3 * h,
      list: 'heist-game.examplestudio.github.com', taught: { ago: 1 * d, source: 'rule' },
      html: githubHtml('examplestudio/heist-game', 'PR #219', '<b>@sam-carter</b> requested your review.<br><br>Caps the lightmap streamer at 180 MB and loads level 4 in two passes. Should fix the crash in #198.', 'https://github.com/examplestudio/heist-game/pull/219'),
    },

    // ---- Skipped the inbox (Gmail filters and Superhuman's auto-archive)
    {
      acc: 'me', group: 'money_security', from: ['Librăria Cetății', 'comenzi@librariacetatii.example'], subject: 'Informare incident de securitate', ago: 2 * d + 2 * h, skipped: true, why: 'mentions "securitate"',
      text: 'Stimate client,\n\nVă informăm că pe 24 octombrie 2026 am identificat un acces neautorizat la o parte din baza de date cu clienți a magazinului online. Datele afectate pot include numele, adresa de email, adresa de livrare și istoricul comenzilor. Datele cardurilor nu sunt stocate de noi și nu au fost afectate.\n\nVă recomandăm să schimbați parola contului Librăria Cetății și să fiți atent la emailuri care par să vină de la noi.\n\nEchipa Librăria Cetății',
    },
    {
      acc: 'me', group: 'purchases', from: ['FAN Courier', 'notificari@fancourier.ro'], subject: 'Coletul tău a fost livrat', ago: 3 * d + 1 * h, skipped: true, why: 'mentions "colet"',
      text: 'Coletul cu AWB 7002 1934 5512 a fost livrat. Mulțumim că ai ales FAN Courier.',
    },
    {
      acc: 'me', group: 'news', from: ['Medium Daily Digest', 'noreply@medium.com'], subject: 'The one habit that made me a better engineer', ago: 1 * d + 5 * h, skipped: true,
      text: 'Today\'s highlights: The one habit that made me a better engineer · Stop writing clever code · How we cut our CI time in half',
    },
    {
      acc: 'ops', group: 'money_security', from: ['Orange', 'factura@orange.ro'], subject: 'Factura Orange pentru octombrie este disponibilă', ago: 4 * d + 2 * h, skipped: true, why: 'mentions "factura"',
      text: 'Factura ta Orange în valoare de 64,00 lei este disponibilă în contul My Orange. Scadență: 20 noiembrie 2026.',
    },
    {
      acc: 'ops', group: 'dev', from: ['Sentry', 'noreply@md.getsentry.com'], subject: 'New issue: NullReferenceException in LockpickController.Update', ago: 5 * d + 7 * h, skipped: true, why: 'known dev sender getsentry.com',
      text: 'A new issue was seen 41 times in heist-game (production).\n\nNullReferenceException: Object reference not set to an instance of an object\n  at LockpickController.Update () [0x0001c] in LockpickController.cs:88',
    },

    // ---- Marked Done (the last one too long ago for "Show done")
    {
      acc: 'me', group: 'purchases', from: ['eMAG', 'comenzi@emag.ro'], subject: 'Comanda ta a fost livrată', ago: 6 * h, doneAgo: 5 * h, why: 'mentions "comanda"',
      text: 'Comanda ta #48213977 a fost livrată. Îți mulțumim că ai cumpărat de la eMAG!',
    },
    {
      acc: 'me', group: 'dev', from: github, subject: '[examplestudio/heist-game] Merged: Fix door collider on level 2 (PR #214)', ago: 1 * d + 3 * h, doneAgo: 1 * d, why: 'known dev sender github.com',
      text: 'Merged #214 into main. All checks passed.',
    },
    {
      acc: 'ops', group: 'money_security', from: ['BCR', 'alerte@bcr.ro'], subject: 'Extras de cont septembrie', ago: 9 * d, doneAgo: 8 * d, why: 'mentions "extras"',
      text: 'Extrasul de cont pentru septembrie este disponibil în George.',
    },
    {
      acc: 'me', group: 'news', from: ['Hacker Newsletter', 'editor@hackernewsletter.com'], subject: 'Hacker Newsletter #712', ago: 41 * d, doneAgo: 40 * d, list: 'hackernewsletter.com',
      text: 'The week in links.',
    },
  ];
}

/** Six messages in spam, in both accounts. Their remote images never resolve: `.example` is a reserved domain. */
function spamSpecs(): ThreadSpec[] {
  const d = DAY;
  const h = 3_600_000;
  const pixel = '<img src="https://track.mailer.example/open.gif?id=8841" width="1" height="1" alt="">';
  return [
    {
      acc: 'me', group: 'unsorted', from: ['Premii Online', 'premii@castiga-acum.example'], subject: 'Felicitări! Ai câștigat un telefon nou', ago: 2 * h, unread: true,
      html: `<table width="600" background="https://cdn.mailer.example/confetti.png" style="background-image:url(https://cdn.mailer.example/confetti.png);color:#fff;background-color:#b91c1c"><tr><td style="padding:24px"><img src="https://cdn.mailer.example/phone.png" alt="Telefon nou" width="300" height="200"><h2>Felicitări!</h2><p>Ai fost ales câștigător. Confirmă-ți adresa în 24 de ore.</p><p><a href="https://castiga-acum.example/confirma" style="color:#fff">Revendică premiul</a></p></td></tr></table>${pixel}`,
    },
    {
      acc: 'me', group: 'unsorted', from: ['Account Security', 'no-reply@secure-login.example'], subject: 'Your account will be suspended in 24 hours', ago: 7 * h, unread: true,
      html: `<p>We could not verify your account. It will be suspended in 24 hours unless you sign in below.</p><p><a href="https://secure-login.example/verify?u=8841">Verify my account</a></p><p><img src="https://secure-login.example/logo.png" alt="Security team"></p>${pixel}`,
    },
    {
      acc: 'ops', group: 'unsorted', from: ['Accounts Payable', 'billing@invoice-center.example'], subject: 'Overdue invoice 8841: payment needed today', ago: 1 * d + 3 * h, unread: true,
      text: 'Please see the attached invoice. Payment is overdue and the case goes to collection today.\n\nAccounts Payable',
      attachments: [{ filename: 'Invoice_8841.pdf', kind: 'pdf', lines: ['Invoice 8841'] }],
    },
    {
      acc: 'ops', group: 'unsorted', from: ['Crypto Signals', 'hello@coin-signals.example'], subject: '300% in 30 days, guaranteed', ago: 2 * d + 5 * h,
      html: `<div style="background:#0f172a url('https://cdn.mailer.example/chart.png') no-repeat;color:#e2e8f0;padding:24px"><h2>Don't miss the next pump</h2><p>Join 40,000 traders. <a href="https://coin-signals.example/join" style="color:#38bdf8">Get the signal</a></p></div>${pixel}`,
    },
    {
      acc: 'me', group: 'unsorted', from: ['Colete Rapide', 'info@colete-rapide.example'], subject: 'Coletul tău așteaptă: plătește taxa de 2,99 lei', ago: 4 * d + 2 * h,
      text: 'Coletul tău este blocat în depozit. Plătește taxa de livrare aici: https://colete-rapide.example/plata',
    },
    {
      acc: 'me', group: 'unsorted', from: ['Replica Watches', 'sales@watches-outlet.example'], subject: 'Luxury watches at 90% off', ago: 9 * d,
      html: `<p>Best prices of the year. <a href="https://watches-outlet.example">Shop now</a></p><p><img srcset="https://cdn.mailer.example/watch.png 1x, https://cdn.mailer.example/watch@2x.png 2x" alt="A watch"></p>`,
    },
  ];
}

/** Fills the quoted-reply placeholders ('q1'…) so each reply quotes the conversation before it, like Gmail. */
function paulReply(prev: { at: number; html: string }): string {
  return quoted(
    'Here you go. "Tense" builds on a muted double bass and brushes; "Playful" is the same theme on vibraphone. Both are 58 seconds and loop cleanly at bar 24.<br><br>Paul',
    { who: 'Alex Doe', email: OPS, at: prev.at, html: prev.html },
  );
}

const REPLIES: Record<string, string> = {
  q1: 'Sună super. Vineri seara pot pleca abia după 7, am un call cu publisher-ul. E ok dacă venim cu mașina mea și plecăm sâmbătă dimineață?',
  q2: 'Sigur, nicio problemă. Atunci rezerv eu cabana în seara asta, e 180 lei de persoană pe noapte. Îți trimit linkul ca să vezi pozele.',
  q3: 'Am rezervat! Confirmarea e mai jos. Mai rămâne doar să vedem cine aduce ce de mâncare — eu iau carnea pentru grătar, voi vedeți de restul?<br><br>Cabana Poiana Ursului · 8–9 noiembrie · cod rezervare BRV-55821',
};

let attachmentSeq = 0;

function buildThread(s: ThreadSpec, seq: number, now: number, blobs: Map<string, Uint8Array>): MockThread {
  const accountId = s.acc === 'me' ? ACC_ME : ACC_OPS;
  const myAddress: AddressDTO = { name: 'Alex Doe', email: s.acc === 'me' ? ME : OPS };
  const gmailThreadId = `19a${(0x2f00 + seq).toString(16)}c${(seq * 7919).toString(16).padStart(6, '0')}`;
  const msgSpecs: MessageSpec[] = s.messages ?? [{ from: s.from, ago: s.ago, text: s.text, html: s.html, attachments: s.attachments, cc: s.cc }];
  const messages: MessageDTO[] = [];
  msgSpecs.forEach((ms, i) => {
    const date = now - ms.ago;
    const from = ms.from === 'me' ? myAddress : { name: ms.from[0], email: ms.from[1] };
    const otherParty: AddressDTO = { name: s.from[0], email: s.from[1] };
    const prev = messages[i - 1];
    let html = ms.html ?? null;
    if (html && (html in REPLIES || html === 'q-paul') && prev) {
      const prevHtml = prev.html ?? (prev.text ?? '').replace(/\n/g, '<br>');
      html =
        html === 'q-paul'
          ? paulReply({ at: prev.date, html: prevHtml })
          : quoted(REPLIES[html]!, { who: prev.from.name ?? prev.from.email, email: prev.from.email, at: prev.date, html: prevHtml });
    }
    const attachments: AttachmentDTO[] = (ms.attachments ?? []).map((a) => {
      const attachmentId = `ANGjdJ${(++attachmentSeq).toString(36).padStart(4, '0')}x${seq}`;
      const bytes = a.kind === 'pdf' ? makePdf(a.lines ?? [a.filename]) : makePng();
      blobs.set(attachmentId, bytes);
      return { attachmentId, filename: a.filename, mimeType: a.kind === 'pdf' ? 'application/pdf' : 'image/png', size: bytes.length };
    });
    messages.push({
      id: `${gmailThreadId}-${i}`,
      gmailMessageId: `${gmailThreadId.slice(0, -2)}${(i + 16).toString(16)}`,
      from,
      to: ms.to ?? [ms.from === 'me' ? otherParty : myAddress],
      cc: ms.cc ?? [],
      date,
      subject: i === 0 ? s.subject : `Re: ${s.subject}`,
      html,
      text: html ? null : (ms.text ?? ''),
      attachments,
    });
  });
  const last = messages.at(-1)!;
  const reason = s.taught ? taughtReason(s.group, now - s.taught.ago, s.taught.source) : guessedReason(s);
  return {
    id: `${accountId}:${gmailThreadId}`,
    accountId,
    subject: s.subject,
    fromName: last.from.name,
    fromEmail: last.from.email,
    listId: s.list ?? null,
    lastMessageAt: last.date,
    surfacedAt: null,
    unread: !!s.unread,
    inInbox: !s.snoozedFor && !s.skipped && s.doneAgo === undefined,
    groupId: s.group,
    reason,
    snoozedUntil: s.snoozedFor ? now + s.snoozedFor : null,
    skipped: !!s.skipped,
    doneAt: s.doneAgo === undefined ? null : now - s.doneAgo,
    suggestRule: !!s.suggestRule,
    messages,
  };
}

export function buildWorld(now: number): MockWorld {
  attachmentSeq = 0;
  const blobs = new Map<string, Uint8Array>();
  const threads = specs().map((s, i) => buildThread(s, i + 1, now, blobs));
  // Their own range of ids, so `world.seq` and the live mail stay as they were.
  const spam = spamSpecs().map((s, i) => buildThread(s, 3000 + i, now, blobs));
  return {
    me: ME,
    accounts: [
      { id: ACC_ME, email: ME, color: '#2563eb', status: 'ok' },
      { id: ACC_OPS, email: OPS, color: '#16a34a', status: 'ok' },
    ],
    groups: GROUPS.map((g) => ({ ...g })),
    threads,
    spam,
    labels: [
      { name: 'Legal - Example Studio SRL', accountIds: [ACC_OPS] },
      { name: 'Taxes 2025', accountIds: [ACC_ME, ACC_OPS] },
      { name: 'Receipts', accountIds: [ACC_ME] },
      { name: 'Travel', accountIds: [ACC_ME] },
    ],
    filters: [
      {
        accountId: ACC_ME, filterId: 'ANe1BmhX4kq2', criteria: 'from:(librariacetatii.example)', hides: ['skip_inbox', 'mark_read'],
        gmailSettingsUrl: `https://mail.google.com/mail/u/?authuser=${ME}#settings/filters`,
      },
      {
        accountId: ACC_ME, filterId: 'ANe1BmhR7tz9', criteria: 'from:(noreply@medium.com)', hides: ['skip_inbox'],
        gmailSettingsUrl: `https://mail.google.com/mail/u/?authuser=${ME}#settings/filters`,
      },
      {
        accountId: ACC_OPS, filterId: 'ANe1BmgQ2pc5', criteria: 'from:(noreply@md.getsentry.com) subject:(New issue)', hides: ['skip_inbox', 'mark_read'],
        gmailSettingsUrl: `https://mail.google.com/mail/u/?authuser=${OPS}#settings/filters`,
      },
    ],
    blobs,
    seq: threads.length + 1,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Live mail, one every 45 s over /api/events

const INCOMING: ThreadSpec[] = [
  {
    acc: 'ops', group: 'dev', from: github, subject: '[examplestudio/heist-game] dan-marin approved PR #212', ago: 0, unread: true,
    list: 'heist-game.examplestudio.github.com', taught: { ago: DAY, source: 'rule' },
    html: githubHtml('examplestudio/heist-game', 'PR #212', '<b>@dan-marin</b> approved these changes.<br><br>Tested on Quest 3: the lockpick no longer slips. Ship it.', 'https://github.com/examplestudio/heist-game/pull/212'),
  },
  {
    acc: 'me', group: 'important', from: sam, subject: 'Am uitat: ia și tu sacul de dormit', ago: 0, unread: true, taught: { ago: DAY, source: 'mark' },
    text: 'Cabana are paturi, dar nu are destule pături pentru toată lumea. Dacă ai un sac de dormit, ia-l. Mersi!',
  },
  {
    acc: 'me', group: 'money_security', from: revolut, subject: 'Payment of 23,40 RON to Bolt', ago: 0, unread: true,
    text: 'You paid 23,40 RON to Bolt with your card ending 4417.',
  },
  {
    acc: 'ops', group: 'low_priority', from: alibaba, subject: 'New arrivals from suppliers you follow', ago: 0, unread: true,
    html: alibabaPromo('New arrivals', 'Fresh products from 12 suppliers you follow.'),
  },
  {
    acc: 'ops', group: 'dev', from: vercel, subject: 'Deployment ready: examplestudio-website', ago: 0, unread: true,
    html: vercelHtml('Your deployment is ready', 'examplestudio-website', 'The type error is fixed and production is serving the latest commit.', true),
  },
  {
    acc: 'me', group: 'purchases', from: bolt, subject: 'Your Bolt trip this evening', ago: 0, unread: true,
    html: boltReceipt('Today', 'Piața Victoriei 1', 'Str. Exemplului 10', '24,10 lei'),
    attachments: [{ filename: 'Bolt-receipt-today.pdf', kind: 'pdf', lines: ['Bolt Operations OU', 'Ride receipt', '', 'Total 24,10 lei'] }],
  },
];

/** The next live thread: a new message that has just arrived. */
export function incomingThread(world: MockWorld, now: number): MockThread {
  const seq = world.seq++;
  const spec = INCOMING[seq % INCOMING.length]!;
  return buildThread(spec, seq, now, world.blobs);
}

/** A message the owner sends, as the next message of a thread (or the first of a new one). */
export function sentMessage(world: MockWorld, from: AddressDTO, to: AddressDTO[], cc: AddressDTO[], subject: string, text: string, now: number, threadKey: string): MessageDTO {
  const seq = world.seq++;
  return {
    id: `${threadKey}-s${seq}`,
    gmailMessageId: `${threadKey.slice(0, 8)}s${seq.toString(16)}`,
    from,
    to,
    cc,
    date: now,
    subject,
    html: null,
    text,
    attachments: [],
  };
}
