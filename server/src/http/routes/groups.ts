import { randomUUID } from 'node:crypto';
import type { GmailLabelDTO, GroupDTO } from '@supermail/shared';
import type { DB } from '../../db/index.js';
import { HttpError } from '../../errors.js';
import { applyThreadLabels, isLabelEligible } from '../../labels/labelWriter.js';
import { adoptExistingLabel, publishGroups, publishThread, reclassifyThreads } from '../../threads/classifyThread.js';
import { groupCounts } from '../../threads/queries.js';
import type { RoutePlugin } from '../app.js';

const CUSTOM_COLORS = ['#0d9488', '#7c3aed', '#be123c', '#65a30d', '#0369a1', '#a16207'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const isSuperMailLabel = (name: string) => /^supermail(\/|$)/i.test(name);

interface GroupRow { id: string; name: string; kind: 'builtin' | 'custom' | 'existing_label' }

const body = (req: { body: unknown }) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});
const activeAccounts = (db: DB) => db.prepare("SELECT id FROM accounts WHERE status != 'reconnect_needed' ORDER BY created_at, id").pluck().all() as string[];

function groupDTO(db: DB, id: string): GroupDTO {
  const g = groupCounts(db).find((x) => x.id === id);
  if (!g) throw new HttpError(404, 'No such group');
  return g;
}

function findGroup(db: DB, id: string): GroupRow {
  const g = db.prepare('SELECT id, name, kind FROM groups WHERE id = ?').get(id) as GroupRow | undefined;
  if (!g) throw new HttpError(404, 'No such group');
  return g;
}

function assertNameFree(db: DB, name: string, exceptId?: string): void {
  if (db.prepare('SELECT 1 FROM groups WHERE lower(name) = lower(?) AND id != ?').get(name, exceptId ?? '')) throw new HttpError(409, `A group named "${name}" already exists`);
}

function labelsByAccount(db: DB, groupId: string): Map<string, string> {
  const rows = db.prepare('SELECT account_id, gmail_label_id FROM group_labels WHERE group_id = ?').all(groupId) as { account_id: string; gmail_label_id: string }[];
  return new Map(rows.map((r) => [r.account_id, r.gmail_label_id]));
}

/**
 * `GET|POST /api/groups`, `PATCH|DELETE /api/groups/:id` and `GET /api/labels`. A group made from an existing
 * Gmail label uses that label in place in every account that has it, and is never renamed in Gmail.
 */
export const groupsRoutes: RoutePlugin = async (app, deps) => {
  const { db } = deps;

  app.get('/api/groups', async (req) => groupCounts(db, (req.query as { accountId?: string }).accountId || undefined));

  app.post('/api/groups', async (req) => {
    const b = body(req);
    const existing = typeof b.existingLabelName === 'string' ? b.existingLabelName.trim() : undefined;
    if (b.existingLabelName !== undefined && !existing) throw new HttpError(400, 'existingLabelName must be a label name');
    if (existing && isSuperMailLabel(existing)) throw new HttpError(400, 'SuperMail labels cannot be used as a group');
    const name = (typeof b.name === 'string' ? b.name.trim() : '') || existing;
    if (!name) throw new HttpError(400, 'name is required');
    if (b.color !== undefined && (typeof b.color !== 'string' || !COLOR_RE.test(b.color))) throw new HttpError(400, 'color must be #rrggbb');
    assertNameFree(db, name);
    if (existing && db.prepare('SELECT 1 FROM groups WHERE lower(existing_label_name) = lower(?)').get(existing)) throw new HttpError(409, `"${existing}" is already a group`);

    const id = randomUUID();
    const position = ((db.prepare('SELECT max(position) FROM groups').pluck().get() as number | null) ?? -1) + 1;
    const color = (b.color as string | undefined) ?? CUSTOM_COLORS[position % CUSTOM_COLORS.length]!;
    db.prepare('INSERT INTO groups(id, name, position, color, notify, kind, existing_label_name) VALUES (?, ?, ?, ?, 1, ?, ?)').run(
      id, name, position, color, existing ? 'existing_label' : 'custom', existing ?? null,
    );
    if (existing) await adoptExistingLabel(db, deps.gmailFor, id, activeAccounts(db), deps.now(), req.log);
    publishGroups(db);
    return groupDTO(db, id);
  });

  app.patch('/api/groups/:id', async (req) => {
    const g = findGroup(db, (req.params as { id: string }).id);
    const b = body(req);
    const name = typeof b.name === 'string' ? b.name.trim() : undefined;
    if (b.name !== undefined && !name) throw new HttpError(400, 'name must not be empty');
    if (b.color !== undefined && (typeof b.color !== 'string' || !COLOR_RE.test(b.color))) throw new HttpError(400, 'color must be #rrggbb');
    if (b.position !== undefined && !Number.isInteger(b.position)) throw new HttpError(400, 'position must be an integer');
    if (b.notify !== undefined && typeof b.notify !== 'boolean') throw new HttpError(400, 'notify must be true or false');
    if (name && name !== g.name) assertNameFree(db, name, g.id);

    const renamed = !!name && name !== g.name;
    // A SuperMail/<name> label follows the group's name: the next write creates the new label, and threads in the
    // inbox or snoozed move from the old label to the new one. An existing Gmail label is never renamed.
    const oldLabels = renamed && g.kind !== 'existing_label' ? labelsByAccount(db, g.id) : new Map<string, string>();
    db.transaction(() => {
      if (renamed) db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, g.id);
      if (b.color !== undefined) db.prepare('UPDATE groups SET color = ? WHERE id = ?').run(b.color, g.id);
      if (b.position !== undefined) db.prepare('UPDATE groups SET position = ? WHERE id = ?').run(b.position, g.id);
      if (b.notify !== undefined) db.prepare('UPDATE groups SET notify = ? WHERE id = ?').run(b.notify ? 1 : 0, g.id);
      if (oldLabels.size) db.prepare('DELETE FROM group_labels WHERE group_id = ?').run(g.id);
    })();
    if (oldLabels.size) {
      const threads = db.prepare('SELECT id, account_id FROM threads WHERE group_id = ?').all(g.id) as { id: string; account_id: string }[];
      for (const t of threads.filter((x) => oldLabels.has(x.account_id) && isLabelEligible(db, x.id))) {
        try {
          await applyThreadLabels(db, deps.gmailFor(t.account_id), t.id, { alsoRemove: [oldLabels.get(t.account_id)!], now: deps.now() });
        } catch (err) {
          req.log.error({ threadId: t.id, err }, 'relabelling after a group rename failed');
        }
        publishThread(db, t.id);
      }
    }
    publishGroups(db);
    return groupDTO(db, g.id);
  });

  app.delete('/api/groups/:id', async (req) => {
    const g = findGroup(db, (req.params as { id: string }).id);
    if (g.kind === 'builtin') throw new HttpError(400, 'Built-in groups cannot be deleted');
    const threads = db.prepare('SELECT id FROM threads WHERE group_id = ? UNION SELECT thread_id FROM overrides WHERE group_id = ?').pluck().all(g.id, g.id) as string[];
    // Our own SuperMail/<name> label comes off the threads we relabel; the owner's existing label stays.
    const oldLabels = g.kind === 'custom' ? labelsByAccount(db, g.id) : new Map<string, string>();
    db.prepare('DELETE FROM groups WHERE id = ?').run(g.id); // cascades rules, overrides and label mappings
    await reclassifyThreads(db, deps.gmailFor, threads, deps.now(), {
      log: req.log,
      alsoRemove: (accountId) => {
        const label = oldLabels.get(accountId);
        return label ? [label] : [];
      },
    });
    publishGroups(db);
    return { ok: true };
  });

  app.get('/api/labels', async (req) => {
    const byName = new Map<string, GmailLabelDTO>();
    for (const accountId of activeAccounts(db)) {
      let labels;
      try {
        labels = await deps.gmailFor(accountId).listLabels();
      } catch (err) {
        req.log.warn({ accountId, err }, 'could not list Gmail labels');
        continue;
      }
      for (const l of labels) {
        if (l.type !== 'user' || isSuperMailLabel(l.name)) continue;
        const entry = byName.get(l.name) ?? { name: l.name, accountIds: [] };
        if (!entry.accountIds.includes(accountId)) entry.accountIds.push(accountId);
        byName.set(l.name, entry);
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
};
