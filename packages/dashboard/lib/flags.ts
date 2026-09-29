import 'server-only';
import { apiFetch } from './api';

/** Shapes returned by the Express API. Kept in step with packages/api. */

export interface TargetingRule {
  attribute: string;
  operator: 'in' | 'eq';
  values: string[];
}

export interface Flag {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  rolloutPercentage: number;
  targetingRules: TargetingRule[];
  createdAt: string;
  updatedAt: string;
  /** Email of the last actor, or 'System (integration)'. Null if never changed. */
  lastUpdatedBy: string | null;
  lastUpdatedAt: string | null;
}

export interface AuditEntry {
  id: string;
  action: 'create' | 'update' | 'delete';
  actor: string;
  actorLabel: string;
  oldValue: Partial<Flag> | null;
  newValue: Partial<Flag> | null;
  createdAt: string;
}

export async function listFlags(): Promise<Flag[]> {
  const { flags } = await apiFetch<{ flags: Flag[] }>('/api/flags');
  return flags;
}

export async function getFlag(key: string): Promise<Flag> {
  return apiFetch<Flag>(`/api/flags/${encodeURIComponent(key)}`);
}

export async function getFlagAudit(key: string): Promise<AuditEntry[]> {
  const { entries } = await apiFetch<{ entries: AuditEntry[] }>(
    `/api/flags/${encodeURIComponent(key)}/audit`,
  );
  return entries;
}
