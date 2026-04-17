import express from 'express';
import { Webhooks } from '@octokit/webhooks';
import { fixQueue, getPendingAutoMerge, deletePendingAutoMerge } from './queue.js';
import { logger } from './logger.js';
import { mergePullRequest, getCheckRunsForRef } from './github.js';

const webhooks = new Webhooks({
  secret: process.env.GITHUB_WEBHOOK_SECRET!,
});

// Chỉ trigger khi workflow_run completed với conclusion = failure
webhooks.on('workflow_run.completed', async ({ payload }) => {
  const { workflow_run, repository, installation } = payload;

  if (workflow_run.conclusion !== 'failure') return;
  if (workflow_run.head_branch === 'main') return; // Không fix main trực tiếp
  if (workflow_run.actor.login.endsWith('[bot]')) return; // Tránh loop với chính bot

  // Idempotency: 1 job duy nhất per (repo, sha, run_id)
  const jobId = `${repository.full_name}-${workflow_run.head_sha}-${workflow_run.id}`;

  await fixQueue.add(
    'fix-ci-failure',
    {
      installationId: installation!.id,
      repoFullName: repository.full_name,
      repoCloneUrl: repository.clone_url,
      headSha: workflow_run.head_sha,
      headBranch: workflow_run.head_branch,
      workflowRunId: workflow_run.id,
      workflowName: workflow_run.name,
    },
    { jobId, attempts: 1 } // KHÔNG retry tự động ở queue level — bot tự xử lý retry logic
  );

  logger.info({ jobId }, 'Queued fix job');
});

webhooks.on('check_run.completed', async ({ payload }) => {
  const { check_run, repository, installation } = payload;
  if (!installation) return;

  const sha = check_run.head_sha;
  const pending = await getPendingAutoMerge(repository.full_name, sha);
  if (!pending) return;

  if (Date.now() < pending.mergeAfter) {
    logger.info(
      { pr: pending.prNumber, remainingMs: pending.mergeAfter - Date.now() },
      'Auto-merge cooldown not elapsed yet'
    );
    return;
  }

  const [owner, repo] = repository.full_name.split('/');
  const checkRuns = await getCheckRunsForRef(installation.id, owner, repo, sha);
  const allPassed =
    checkRuns.length > 0 &&
    checkRuns.every(
      r =>
        r.status === 'completed' &&
        (r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped')
    );

  if (!allPassed) {
    logger.info({ pr: pending.prNumber }, 'Not all checks passed, skipping auto-merge');
    return;
  }

  try {
    await mergePullRequest(installation.id, owner, repo, pending.prNumber);
    await deletePendingAutoMerge(repository.full_name, sha);
    logger.info({ pr: pending.prNumber }, 'Auto-merged PR');
  } catch (err) {
    logger.warn({ err, pr: pending.prNumber }, 'Auto-merge failed');
  }
});

const app = express();

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      await webhooks.verifyAndReceive({
        id: req.headers['x-github-delivery'] as string,
        name: req.headers['x-github-event'] as any,
        signature: req.headers['x-hub-signature-256'] as string,
        payload: req.body.toString(),
      });
      res.status(202).send('ok');
    } catch (err) {
      logger.error({ err }, 'Webhook verification failed');
      res.status(400).send('invalid');
    }
  }
);

app.get('/health', (_, res) => res.send('ok'));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => logger.info(`Webhook server on :${port}`));
