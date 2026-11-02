import { describe, expect, it } from 'vitest';
import { type ClassifyInput, heuristicGroupKey, matchKeys } from '../src/classify/heuristics.js';
import { type GroupRef, type Mark, type Rule, resolveGroup } from '../src/classify/resolve.js';
import { BUILTIN_GROUPS } from '../src/db/seed.js';

function input(p: Partial<ClassifyInput>): ClassifyInput {
  return { fromEmail: null, listId: null, labelIds: ['INBOX'], subject: '', snippet: '', hasListUnsubscribe: false, ...p };
}

const OCT_28 = Date.UTC(2026, 9, 28, 12);

const GROUPS: GroupRef[] = [
  ...BUILTIN_GROUPS.map((g) => ({ id: g.key, name: g.name, builtinKey: g.key, kind: 'builtin' as const, labelIdsByAccount: new Map<string, string>() })),
  { id: 'legal', name: 'Legal - Example Studio SRL', builtinKey: null, kind: 'existing_label', labelIdsByAccount: new Map([['a', 'Label_42']]) },
];

describe('heuristicGroupKey', () => {
  it.each<[string, Partial<ClassifyInput>, string]>([
    ['bookstore security incident with a List-Id is not news', {
      fromEmail: 'newsletter@librariacetatii.example', listId: '<newsletter.librariacetatii.example>', hasListUnsubscribe: true,
      labelIds: ['INBOX', 'CATEGORY_UPDATES'], subject: 'Informare incident de securitate',
    }, 'money_security'],
    ['Google security alert', { fromEmail: 'no-reply@accounts.google.com', subject: 'Security alert', snippet: 'A new sign-in on Linux' }, 'money_security'],
    ['GitHub notification', { fromEmail: 'notifications@github.com', listId: '<supermail.alex-example.github.com>', hasListUnsubscribe: true, subject: '[super-mail] PR #12' }, 'dev'],
    ['Vercel failed deployment', { fromEmail: 'notifications@vercel.com', subject: 'Failed production deployment on super-mail' }, 'dev'],
    ['Bolt ride receipt', { fromEmail: 'receipts@bolt.eu', subject: 'Your Bolt Scooter ride', snippet: "Thanks for riding with Bolt. Here's your receipt" }, 'purchases'],
    ['Alibaba promotion', { fromEmail: 'promo@notice.alibaba.com', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], hasListUnsubscribe: true, subject: 'Top deals picked for you' }, 'low_priority'],
    ['Weekend school newsletter', { fromEmail: 'hello@scoaladeweekend.example', hasListUnsubscribe: true, labelIds: ['INBOX', 'CATEGORY_UPDATES'], subject: 'New lesson this week' }, 'news'],
    ['personal mail from a person', { fromEmail: 'sam@carter.example', labelIds: ['INBOX', 'CATEGORY_PERSONAL'], subject: 'Coffee next week?' }, 'important'],
    ['info@ sender with no headers', { fromEmail: 'info@shop.ro', subject: 'Hello' }, 'unsorted'],
    // Edge cases beyond the plan's table.
    ['bank subdomain counts as the bank', { fromEmail: 'no-reply@mail.revolut.com', subject: 'Hi' }, 'money_security'],
    ['keywords ignore diacritics', { fromEmail: 'x@furnizor.ro', subject: 'Factură nouă' }, 'money_security'],
    ['keywords match at word starts only', { fromEmail: 'x@shop.ro', subject: 'O recomandare pentru tine', labelIds: ['INBOX', 'CATEGORY_UPDATES'] }, 'unsorted'],
    ['non-personal category without list headers is unsorted', { fromEmail: 'ana@x.ro', labelIds: ['INBOX', 'CATEGORY_UPDATES'] }, 'unsorted'],
    ['no sender is unsorted', { fromEmail: null }, 'unsorted'],
  ])('%s', (_name, p, key) => {
    expect(heuristicGroupKey(input(p)).key).toBe(key);
  });

  it('explains the guess', () => {
    expect(heuristicGroupKey(input({ fromEmail: 'notifications@github.com' })).why).toBe('known dev sender github.com');
  });
});

describe('matchKeys', () => {
  it('lowercases the sender, takes the domain after @ and the List-Id inside angle brackets', () => {
    expect(matchKeys(input({ fromEmail: ' Bob@Example.COM ', listId: '"Dev list" <Dev.Example.com>' }))).toEqual({
      sender: 'bob@example.com', domain: 'example.com', list: 'dev.example.com',
    });
    expect(matchKeys(input({}))).toEqual({ sender: null, domain: null, list: null });
  });
});

describe('resolveGroup', () => {
  const github = { ...input({ fromEmail: 'notifications@github.com' }), accountId: 'a' };
  const rule = (matchType: Rule['matchType'], matchValue: string, groupId: string): Rule => ({ matchType, matchValue, groupId, createdAt: OCT_28 });
  const mark = (matchType: Mark['matchType'], matchValue: string, m: Mark['mark']): Mark => ({ matchType, matchValue, mark: m, createdAt: OCT_28 });

  it('an override beats a rule', () => {
    const r = resolveGroup(github, { override: { groupId: 'news', source: 'app', createdAt: OCT_28 }, rules: [rule('sender', 'notifications@github.com', 'dev')], marks: [] }, GROUPS);
    expect(r.groupId).toBe('news');
    expect(r.reason).toEqual({ source: 'override', text: 'In News because you said so on 28 Oct', at: OCT_28 });
  });

  it('a sender rule beats a list rule, which beats a domain rule', () => {
    const withList = { ...github, listId: '<repo.github.com>' };
    const domain = rule('domain', 'github.com', 'low_priority');
    const list = rule('list', 'repo.github.com', 'news');
    const sender = rule('sender', 'notifications@github.com', 'important');
    expect(resolveGroup(withList, { rules: [domain, list, sender], marks: [] }, GROUPS).groupId).toBe('important');
    expect(resolveGroup(withList, { rules: [domain, list], marks: [] }, GROUPS).groupId).toBe('news');
    expect(resolveGroup(withList, { rules: [domain], marks: [] }, GROUPS).groupId).toBe('low_priority');
  });

  it('a not_important mark on a domain sends it to Low priority', () => {
    const alibaba = { ...input({ fromEmail: 'deals@alibaba.com', subject: 'Hello' }), accountId: 'a' };
    const r = resolveGroup(alibaba, { rules: [], marks: [mark('domain', 'alibaba.com', 'not_important')] }, GROUPS);
    expect(r.groupId).toBe('low_priority');
    expect(r.reason.source).toBe('mark');
  });

  it('an important mark sends it to Important', () => {
    const r = resolveGroup(github, { rules: [], marks: [mark('sender', 'notifications@github.com', 'important')] }, GROUPS);
    expect(r.groupId).toBe('important');
    expect(r.reason).toEqual({ source: 'mark', text: 'In Important because you said so on 28 Oct', at: OCT_28 });
  });

  it('a mark beats an existing-label group; without teaching the label applies, only in the account that has it', () => {
    const labelled = { ...github, labelIds: ['INBOX', 'Label_42'] };
    const taught = { rules: [], marks: [mark('sender', 'notifications@github.com', 'not_important')] };
    expect(resolveGroup(labelled, taught, GROUPS).groupId).toBe('low_priority');
    const none = { rules: [], marks: [] };
    const r = resolveGroup(labelled, none, GROUPS);
    expect(r.groupId).toBe('legal');
    expect(r.reason).toEqual({ source: 'existing_label', text: 'In Legal - Example Studio SRL: has your Gmail label "Legal - Example Studio SRL"', at: null });
    expect(resolveGroup({ ...labelled, accountId: 'b' }, none, GROUPS).groupId).toBe('dev');
  });

  it('the most specific teaching wins across rules and marks', () => {
    const sender = 'notifications@github.com';
    expect(resolveGroup(github, { rules: [rule('domain', 'github.com', 'dev')], marks: [mark('sender', sender, 'important')] }, GROUPS).groupId).toBe('important');
    expect(resolveGroup(github, { rules: [rule('sender', sender, 'dev')], marks: [mark('domain', 'github.com', 'not_important')] }, GROUPS).groupId).toBe('dev');
  });

  it('a rule beats an existing label', () => {
    const labelled = { ...github, labelIds: ['INBOX', 'Label_42'] };
    expect(resolveGroup(labelled, { rules: [rule('domain', 'github.com', 'dev')], marks: [] }, GROUPS).groupId).toBe('dev');
  });

  it('the reason text for a rule created 2026-10-28', () => {
    const r = resolveGroup(github, { rules: [rule('domain', 'github.com', 'dev')], marks: [] }, GROUPS);
    expect(r.reason).toEqual({ source: 'rule', text: 'In Dev because you said so on 28 Oct', at: OCT_28 });
  });

  it('falls back to the heuristic with an automatic-guess reason', () => {
    const r = resolveGroup(github, { rules: [], marks: [] }, GROUPS);
    expect(r).toEqual({ groupId: 'dev', reason: { source: 'heuristic', text: 'In Dev: known dev sender github.com (automatic guess)', at: null } });
  });

  it('no confident match is Unsorted with the default reason', () => {
    const r = resolveGroup({ ...input({ fromEmail: 'info@shop.ro' }), accountId: 'a' }, { rules: [], marks: [] }, GROUPS);
    expect(r).toEqual({ groupId: 'unsorted', reason: { source: 'default', text: 'Unsorted: no confident match (automatic guess)', at: null } });
  });

  it('ignores teaching that points at a missing group', () => {
    const r = resolveGroup(github, { override: { groupId: 'gone', source: 'gmail', createdAt: OCT_28 }, rules: [rule('sender', 'notifications@github.com', 'gone')], marks: [] }, GROUPS);
    expect(r.groupId).toBe('dev');
    expect(r.reason.source).toBe('heuristic');
  });
});
