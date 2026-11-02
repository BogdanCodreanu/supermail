import type { GroupKind, GroupReasonDTO, MatchType } from '@supermail/shared';
import { type ClassifyInput, heuristicGroupKey, matchKeys } from './heuristics.js';

export interface Rule { matchType: MatchType; matchValue: string; groupId: string; createdAt: number }
export interface Mark { matchType: MatchType; matchValue: string; mark: 'important' | 'not_important'; createdAt: number }
export interface Override { groupId: string; source: 'app' | 'gmail'; createdAt: number }
export interface GroupRef { id: string; name: string; builtinKey: string | null; kind: GroupKind; labelIdsByAccount: Map<string, string> }

const UNSORTED_ID = 'unsorted';
const UNSORTED_REASON = 'Unsorted: no confident match (automatic guess)';
// Within rules and marks, the most specific key wins.
const MATCH_ORDER: MatchType[] = ['sender', 'list', 'domain'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// en-GB `d MMM`, built by hand so the output does not depend on the ICU build ("Sep" vs "Sept").
function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function taught(g: GroupRef, createdAt: number, source: 'override' | 'rule' | 'mark') {
  return { groupId: g.id, reason: { source, text: `In ${g.name} because you said so on ${shortDate(createdAt)}`, at: createdAt } };
}

// Picks the most specific matching entry whose target group still exists.
function mostSpecific<T extends { matchType: MatchType; matchValue: string }>(
  entries: T[],
  keys: Record<MatchType, string | null>,
  target: (e: T) => GroupRef | undefined,
): { entry: T; group: GroupRef } | undefined {
  for (const type of MATCH_ORDER) {
    const key = keys[type];
    if (!key) continue;
    for (const entry of entries) {
      if (entry.matchType !== type || entry.matchValue.trim().toLowerCase() !== key) continue;
      const group = target(entry);
      if (group) return { entry, group };
    }
  }
  return undefined;
}

/**
 * Picks one group for a thread. Precedence: override, the owner's most specific rule or mark, existing Gmail
 * label, heuristic.
 * `groups` should be in display order; the first existing-label group that matches wins.
 */
export function resolveGroup(
  i: ClassifyInput & { accountId: string },
  t: { override?: Override; rules: Rule[]; marks: Mark[] },
  groups: GroupRef[],
): { groupId: string; reason: GroupReasonDTO } {
  const byId = (id: string) => groups.find((g) => g.id === id);
  const byKey = (key: string) => groups.find((g) => g.builtinKey === key);

  const overridden = t.override && byId(t.override.groupId);
  if (t.override && overridden) return taught(overridden, t.override.createdAt, 'override');

  const keys = matchKeys(i);
  // Rules and marks are one kind of teaching: the most specific match wins (sender, then list, then domain), so a
  // choice about one sender is not lost to a broader rule. Teaching beats an existing Gmail label.
  const rule = mostSpecific(t.rules, keys, (r) => byId(r.groupId));
  const mark = mostSpecific(t.marks, keys, (m) => byKey(m.mark === 'important' ? 'important' : 'low_priority'));
  const rank = (type: MatchType) => MATCH_ORDER.indexOf(type);
  if (rule && (!mark || rank(rule.entry.matchType) <= rank(mark.entry.matchType))) return taught(rule.group, rule.entry.createdAt, 'rule');
  if (mark) return taught(mark.group, mark.entry.createdAt, 'mark');

  const labelled = groups.find((g) => {
    if (g.kind !== 'existing_label') return false;
    const labelId = g.labelIdsByAccount.get(i.accountId);
    return labelId !== undefined && i.labelIds.includes(labelId);
  });
  if (labelled) {
    return { groupId: labelled.id, reason: { source: 'existing_label', text: `In ${labelled.name}: has your Gmail label "${labelled.name}"`, at: null } };
  }

  const guess = heuristicGroupKey(i);
  const guessed = guess.key === 'unsorted' ? undefined : byKey(guess.key);
  if (guessed) return { groupId: guessed.id, reason: { source: 'heuristic', text: `In ${guessed.name}: ${guess.why} (automatic guess)`, at: null } };

  return { groupId: byKey('unsorted')?.id ?? UNSORTED_ID, reason: { source: 'default', text: UNSORTED_REASON, at: null } };
}
