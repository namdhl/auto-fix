import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

export interface FixJob {
  installationId: number;
  repoFullName: string;
  repoCloneUrl: string;
  headSha: string;
  headBranch: string;
  workflowRunId: number;
  workflowName: string;
  attempt?: number; // Bot tự quản lý retry count
}

export const fixQueue = new Queue<FixJob>('ci-fix', {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 86400 * 7 },
  },
});

export interface AutoMergeEntry {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  headBranch: string;
  mergeAfter: number; // Unix ms timestamp
}

function autoMergeKey(repoFullName: string, sha: string) {
  return `auto-merge:${repoFullName}:${sha}`;
}

export async function schedulePrAutoMerge(entry: AutoMergeEntry): Promise<void> {
  await redis.set(autoMergeKey(`${entry.owner}/${entry.repo}`, entry.headSha), JSON.stringify(entry), 'EX', 86400);
}

export async function getPendingAutoMerge(repoFullName: string, sha: string): Promise<AutoMergeEntry | null> {
  const val = await redis.get(autoMergeKey(repoFullName, sha));
  if (!val) return null;
  return JSON.parse(val) as AutoMergeEntry;
}

export async function deletePendingAutoMerge(repoFullName: string, sha: string): Promise<void> {
  await redis.del(autoMergeKey(repoFullName, sha));
}
