import { accountLabels } from '@supermail/shared';

export { accountLabels };

/** Which account received it, for rows in a list that mixes several accounts. */
export function accountTag(list: { id: string; email: string }[] | undefined, id: string) {
  if (!list || list.length < 2) return null;
  const a = list.find((x) => x.id === id);
  return a ? { label: accountLabels(list).get(id) ?? a.email, email: a.email } : null;
}
