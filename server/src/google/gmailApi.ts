import type { gmail_v1 } from 'googleapis';

// Interface only. Task 3 implements it (gmailClient.ts) and provides an in-memory fake for tests.
export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listThreads(p: { q?: string; labelIds?: string[]; pageToken?: string; maxResults?: number }): Promise<{ ids: string[]; nextPageToken?: string }>;
  getThread(id: string, format: 'metadata' | 'full'): Promise<gmail_v1.Schema$Thread>;
  listHistory(startHistoryId: string, pageToken?: string): Promise<{ history: gmail_v1.Schema$History[]; historyId: string; nextPageToken?: string }>; // throws GmailHistoryExpired on 404
  modifyThread(id: string, add: string[], remove: string[]): Promise<void>;
  listLabels(): Promise<{ id: string; name: string; type: 'system' | 'user' }[]>;
  createLabel(name: string): Promise<{ id: string; name: string }>; // throws GmailLabelExists on 409
  sendRaw(rawBase64Url: string, threadId?: string): Promise<{ id: string; threadId: string }>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  listFilters(): Promise<gmail_v1.Schema$Filter[]>;
}

export class GmailHistoryExpired extends Error {
  override name = 'GmailHistoryExpired';
}
export class GmailLabelExists extends Error {
  override name = 'GmailLabelExists';
}
/** A request that timed out or lost its connection: Gmail may or may not have done it. */
export class GmailNoAnswer extends Error {
  override name = 'GmailNoAnswer';
}
export class GmailAuthRevoked extends Error {
  override name = 'GmailAuthRevoked';
} // invalid_grant / 401 after refresh

export const METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Id', 'List-Unsubscribe', 'Message-ID', 'In-Reply-To', 'References'];
