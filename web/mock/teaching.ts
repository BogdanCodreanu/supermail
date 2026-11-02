import type { MatchType, TeachingDTO } from '@supermail/shared';
import type { MockThread } from './fixtures';

/** A rule or mark as the mock stores it. `threadCount` and `groupName` are worked out when it is listed. */
export type MockTeaching = Omit<TeachingDTO, 'groupName' | 'threadCount'>;
export type TeachingKey = Pick<MockTeaching, 'kind' | 'matchType' | 'matchValue'>;

const DAY = 86_400_000;
// As the server's classifier: rules before marks, and within each the most specific key wins.
const MATCH_ORDER: MatchType[] = ['sender', 'list', 'domain'];

/** Matches the taught threads in the fixtures, so the Rules screen starts with something real to show. */
export function seedTeachings(now: number): MockTeaching[] {
  const seed = (id: string, kind: MockTeaching['kind'], matchType: MatchType, matchValue: string, target: string, daysAgo: number): MockTeaching => ({
    id, kind, matchType, matchValue, groupId: kind === 'rule' ? target : null, mark: kind === 'mark' ? (target as MockTeaching['mark']) : null, createdAt: now - daysAgo * DAY,
  });
  return [
    seed('seed-1', 'rule', 'list', 'heist-game.examplestudio.github.com', 'dev', 1),
    seed('seed-2', 'rule', 'domain', 'contabil.example', 'money_security', 1),
    seed('seed-3', 'mark', 'domain', 'service.alibaba.com', 'not_important', 2),
    seed('seed-4', 'mark', 'sender', 'sam_carter@gmail.com', 'important', 5),
  ];
}

/** The key a thread has for a match type, as `matchKeys` on the server. */
export function teachingValue(t: MockThread, type: MatchType): string | null {
  const email = t.fromEmail?.toLowerCase() ?? null;
  if (type === 'sender') return email;
  if (type === 'domain') return email ? email.slice(email.lastIndexOf('@') + 1) : null;
  return t.listId;
}

export const matchesTeaching = (t: MockThread, e: MockTeaching) => teachingValue(t, e.matchType) === e.matchValue;

export const teachingGroup = (e: MockTeaching) => e.groupId ?? (e.mark === 'important' ? 'important' : 'low_priority');

/** The teaching that decides this thread's group now, if any. */
export function nextTeaching(t: MockThread, entries: MockTeaching[]): MockTeaching | undefined {
  for (const kind of ['rule', 'mark'] as const) {
    for (const type of MATCH_ORDER) {
      const e = entries.find((x) => x.kind === kind && x.matchType === type && matchesTeaching(t, x));
      if (e) return e;
    }
  }
  return undefined;
}
