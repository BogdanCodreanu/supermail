import type { QueryClient } from '@tanstack/react-query';
import type { GroupDTO } from '@supermail/shared';
import { api } from '../api/client';

/** New groups take these in turn; the first few are the server's own defaults. */
export const GROUP_PALETTE = ['#0d9488', '#7c3aed', '#be123c', '#65a30d', '#0369a1', '#a16207', '#db2777', '#ea580c'];

/** The first colour no group has, or one by count once they are all taken. */
export function nextGroupColor(groups: Pick<GroupDTO, 'color'>[]): string {
  const used = new Set(groups.map((g) => g.color.toLowerCase()));
  return GROUP_PALETTE.find((c) => !used.has(c)) ?? GROUP_PALETTE[groups.length % GROUP_PALETTE.length]!;
}

/** Creates a group and adds it to the caches at once, so a list can select it before the next refetch. */
export async function createGroup(qc: QueryClient, name: string, groups: GroupDTO[]): Promise<GroupDTO> {
  const g = await api.createGroup({ name, color: nextGroupColor(groups) });
  for (const [key, data] of qc.getQueriesData<GroupDTO[]>({ queryKey: ['groups'] })) {
    if (data && !data.some((x) => x.id === g.id)) qc.setQueryData(key, [...data, g]);
  }
  void qc.invalidateQueries({ queryKey: ['groups'] });
  return g;
}
