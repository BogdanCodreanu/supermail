import type { BuiltinKey } from '../db/seed.js';

export interface ClassifyInput { fromEmail: string | null; listId: string | null; labelIds: string[]; subject: string; snippet: string; hasListUnsubscribe: boolean }

const MONEY_DOMAINS = ['accounts.google.com', 'revolut.com', 'ing.ro', 'ing.com', 'xtb.com', 'tastytrade.com', 'nn.ro', 'zen.com', 'paypal.com', 'wise.com', 'bt.ro', 'raiffeisen.ro'];
const DEV_DOMAINS = ['github.com', 'vercel.com', 'gitlab.com', 'fly.io', 'sentry.io', 'cloudflare.com', 'amazonaws.com', 'npmjs.com', 'docker.com', 'coderabbit.ai'];
const MONEY_WORDS = ['security alert', 'sign-in', 'signin', 'fraud', 'frauda', 'incident de securitate', 'password', 'parola', 'statement', 'extras de cont', 'pensie', 'invoice', 'factura'];
const PURCHASE_WORDS = ['order', 'comanda', 'receipt', 'bon fiscal', 'shipping', 'livrare', 'delivered', 'your ride', 'rezervare', 'booking confirmed'];
const AUTOMATED_LOCAL_PART = /no-?reply|notifications?|mailer|newsletter|info|team|support/i;

// Keywords match at the start of a word, so "recomandare" is not "comanda" and "suspensie" is not "pensie".
function wordsRegex(words: string[]): RegExp {
  return new RegExp(`\\b(?:${words.map((w) => w.replace(/ /g, '\\s+')).join('|')})`, 'i');
}
const MONEY_RE = wordsRegex(MONEY_WORDS);
const PURCHASE_RE = wordsRegex(PURCHASE_WORDS);

// Lowercase and strip diacritics, so "Factură" matches "factura".
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// A subdomain counts as its parent: mail.revolut.com is Revolut.
function knownDomain(domain: string | null, list: string[]): string | undefined {
  if (!domain) return undefined;
  return list.find((d) => domain === d || domain.endsWith(`.${d}`));
}

function normalizeList(listId: string): string {
  const bracketed = /<([^>]*)>/.exec(listId);
  return (bracketed?.[1] ?? listId).trim().toLowerCase();
}

/** The keys that rules and marks match against. All lowercased; `list` is the id inside List-Id's angle brackets. */
export function matchKeys(i: ClassifyInput): { sender: string | null; domain: string | null; list: string | null } {
  const sender = i.fromEmail?.trim().toLowerCase() || null;
  const at = sender?.lastIndexOf('@') ?? -1;
  const domain = sender && at >= 0 ? sender.slice(at + 1) || null : null;
  const list = i.listId ? normalizeList(i.listId) || null : null;
  return { sender, domain, list };
}

/** Deterministic first guess. First match wins; money and security are checked first so they never land in News or Low priority. */
export function heuristicGroupKey(i: ClassifyInput): { key: BuiltinKey; why: string } {
  const { sender, domain } = matchKeys(i);
  const text = fold(`${i.subject} ${i.snippet}`);

  const moneyDomain = knownDomain(domain, MONEY_DOMAINS);
  if (moneyDomain) return { key: 'money_security', why: `known money/security sender ${moneyDomain}` };
  const moneyWord = MONEY_RE.exec(text);
  if (moneyWord) return { key: 'money_security', why: `mentions "${moneyWord[0]}"` };

  const devDomain = knownDomain(domain, DEV_DOMAINS);
  if (devDomain) return { key: 'dev', why: `known dev sender ${devDomain}` };

  const purchaseWord = PURCHASE_RE.exec(text);
  if (purchaseWord) return { key: 'purchases', why: `mentions "${purchaseWord[0]}"` };

  if (i.labelIds.includes('CATEGORY_PROMOTIONS')) return { key: 'low_priority', why: 'Gmail category Promotions' };
  if (i.labelIds.includes('CATEGORY_SOCIAL')) return { key: 'low_priority', why: 'Gmail category Social' };

  if (i.listId) return { key: 'news', why: `mailing list ${normalizeList(i.listId)}` };
  if (i.hasListUnsubscribe) return { key: 'news', why: `newsletter from ${sender ?? 'unknown sender'}` };

  // List headers were handled above, so anything reaching here has none.
  const categories = i.labelIds.filter((l) => l.startsWith('CATEGORY_'));
  const personal = categories.length === 0 || categories.includes('CATEGORY_PERSONAL');
  const localPart = sender?.split('@')[0];
  if (personal && localPart && !AUTOMATED_LOCAL_PART.test(localPart)) {
    return { key: 'important', why: `personal mail from ${sender}` };
  }

  return { key: 'unsorted', why: 'no confident match' };
}
