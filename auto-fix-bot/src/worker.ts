import { Worker } from 'bullmq';
import { simpleGit } from 'simple-git';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { redis, type FixJob, schedulePrAutoMerge } from './queue.js';
import { logger } from './logger.js';
import { getInstallationToken, downloadWorkflowLogs, createPullRequest, createIssue } from './github.js';
import { parseErrors } from './parsers/index.js';
import { generateFix } from './ai/fixer.js';
import { validateFix } from './sandbox.js';
import {
  isFileSafeToModify,
  MAX_DIFF_LINES,
  MAX_FILES_PER_FIX,
  MAX_RETRY_ATTEMPTS,
  AUTO_MERGE_COOLDOWN_MINUTES,
  canAutoMerge,
} from './safety.js';

// Helper: extract zip log từ GitHub (dùng adm-zip hoặc unzip command)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

async function extractLogText(zipBuffer: Buffer, tmpDir: string): Promise<string> {
  const zipPath = path.join(tmpDir, 'logs.zip');
  await fs.writeFile(zipPath, zipBuffer);
  await execFileP('unzip', ['-o', zipPath, '-d', path.join(tmpDir, 'logs')]);
  // Concat tất cả .txt files
  const files = await fs.readdir(path.join(tmpDir, 'logs'), { recursive: true });
  let combined = '';
  for (const f of files) {
    if (typeof f !== 'string' || !f.endsWith('.txt')) continue;
    combined += await fs.readFile(path.join(tmpDir, 'logs', f), 'utf8') + '\n';
  }
  return combined;
}

const worker = new Worker<FixJob>(
  'ci-fix',
  async (job) => {
    const { data } = job;
    const attempt = data.attempt ?? 1;
    const log = logger.child({ jobId: job.id, repo: data.repoFullName, attempt });

    if (attempt > MAX_RETRY_ATTEMPTS) {
      log.warn('Max attempts reached, giving up');
      const [owner, repo] = data.repoFullName.split('/');
      await createIssue(data.installationId, owner, repo, {
        title: `🤖 Auto-fix gave up after ${MAX_RETRY_ATTEMPTS} attempts on \`${data.headBranch}\``,
        body: [
          `The auto-fix bot exhausted all ${MAX_RETRY_ATTEMPTS} retry attempts for a CI failure on commit \`${data.headSha.slice(0, 7)}\`.`,
          '',
          `**Branch**: \`${data.headBranch}\``,
          `**Workflow run**: https://github.com/${data.repoFullName}/actions/runs/${data.workflowRunId}`,
          '',
          'Manual investigation is required.',
          '',
          `@${owner} Please review this CI failure.`,
        ].join('\n'),
        labels: ['auto-fix', 'needs-review'],
      }).catch(err => log.warn({ err }, 'Failed to create gave-up issue'));
      return { status: 'gave_up' };
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fix-'));
    const repoDir = path.join(tmpDir, 'repo');

    try {
      // 1. Download CI logs
      log.info('Downloading workflow logs');
      const [owner, repo] = data.repoFullName.split('/');
      const logZip = await downloadWorkflowLogs(
        data.installationId,
        owner,
        repo,
        data.workflowRunId
      );
      const logText = await extractLogText(logZip, tmpDir);

      // 2. Parse errors
      const errors = parseErrors(logText);
      if (errors.length === 0) {
        log.info('No parseable errors, skipping');
        return { status: 'no_errors_parsed' };
      }
      log.info({ count: errors.length }, 'Parsed errors');

      // 3. Clone repo (shallow, branch của failing commit)
      const token = await getInstallationToken(data.installationId);
      const cloneUrl = `https://x-access-token:${token}@github.com/${data.repoFullName}.git`;
      const git = simpleGit();
      await git.clone(cloneUrl, repoDir, ['--depth', '5', '--branch', data.headBranch]);

      // 4. Đọc nội dung các file lỗi (filter qua safety)
      const filesNeeded = new Set(errors.map(e => e.file).filter(Boolean) as string[]);
      const fileContents: Record<string, string> = {};
      for (const f of filesNeeded) {
        const safety = isFileSafeToModify(f);
        if (!safety.ok) {
          log.warn({ file: f, reason: safety.reason }, 'File blocked by safety');
          continue;
        }
        try {
          fileContents[f] = await fs.readFile(path.join(repoDir, f), 'utf8');
        } catch {
          log.warn({ file: f }, 'File not readable');
        }
      }

      if (Object.keys(fileContents).length === 0) {
        log.info('No safe files to modify');
        return { status: 'no_safe_files' };
      }

      // 5. Gọi LLM
      log.info('Calling OpenAI');
      const fix = await generateFix(errors, fileContents);
      log.info({ confidence: fix.confidence, files: fix.patches.length }, 'Got fix');

      if (fix.confidence === 'low') {
        log.info('Confidence too low, skipping');
        return { status: 'low_confidence', reasoning: fix.reasoning };
      }

      if (fix.patches.length > MAX_FILES_PER_FIX) {
        log.warn('Too many files in patch');
        return { status: 'too_many_files' };
      }

      // 6. Apply patches + double-check safety
      let totalLinesChanged = 0;
      for (const patch of fix.patches) {
        const safety = isFileSafeToModify(patch.file);
        if (!safety.ok) throw new Error(`Unsafe file in patch: ${patch.file}`);

        const filePath = path.join(repoDir, patch.file);
        const before = await fs.readFile(filePath, 'utf8').catch(() => '');
        await fs.writeFile(filePath, patch.newContent);

        const beforeLines = before.split('\n').length;
        const afterLines = patch.newContent.split('\n').length;
        totalLinesChanged += Math.abs(afterLines - beforeLines);
      }

      if (totalLinesChanged > MAX_DIFF_LINES) {
        log.warn({ totalLinesChanged }, 'Diff too large');
        return { status: 'diff_too_large' };
      }

      // 7. Validate trong sandbox
      const lang = errors[0].language;
      const validation = await validateFix(repoDir, lang);
      if (!validation.ok) {
        log.warn({ output: validation.output.slice(-500) }, 'Validation failed');
        // Có thể loop lại với attempt+1, gửi error mới cho LLM
        return { status: 'validation_failed' };
      }

      // 8. Commit + push lên branch mới
      const branchName = `bot/auto-fix-${data.headSha.slice(0, 7)}-${Date.now()}`;
      const repoGit = simpleGit(repoDir);
      await repoGit.addConfig('user.name', 'auto-fix-bot[bot]');
      await repoGit.addConfig('user.email', 'bot@example.com');
      await repoGit.checkoutLocalBranch(branchName);
      await repoGit.add('.');
      await repoGit.commit(`fix(ci): auto-fix ${errors[0].errorType}\n\n${fix.reasoning}`);
      await repoGit.push('origin', branchName);

      // 9. Tạo PR
      const pr = await createPullRequest(data.installationId, owner, repo, {
        title: `🤖 Auto-fix: ${errors[0].errorType} in ${errors[0].file}`,
        head: branchName,
        base: data.headBranch,
        body: [
          `Automated fix for failing CI on commit \`${data.headSha.slice(0, 7)}\`.`,
          '',
          `**Confidence**: ${fix.confidence}`,
          `**Reasoning**: ${fix.reasoning}`,
          '',
          `**Errors fixed**:`,
          ...errors.map(e => `- \`${e.file}:${e.line}\` — ${e.errorType}: ${e.message}`),
          '',
          `_Auto-merge eligible: ${canAutoMerge(errors.map(e => e.errorType))}_`,
          '',
          '> ⚠️ Always review AI-generated fixes before relying on them.',
        ].join('\n'),
      });

      log.info({ pr: pr.number }, 'PR created');

      // 10. Schedule auto-merge if all error types are safe to auto-merge
      if (canAutoMerge(errors.map(e => e.errorType))) {
        await schedulePrAutoMerge({
          installationId: data.installationId,
          owner,
          repo,
          prNumber: pr.number,
          headSha: data.headSha,
          headBranch: data.headBranch,
          mergeAfter: Date.now() + AUTO_MERGE_COOLDOWN_MINUTES * 60 * 1000,
        });
        log.info({ pr: pr.number, cooldownMinutes: AUTO_MERGE_COOLDOWN_MINUTES }, 'Scheduled auto-merge after cooldown');
      }

      return { status: 'pr_created', pr: pr.number };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  },
  {
    connection: redis,
    concurrency: 3, // Tối đa 3 jobs song song
    limiter: { max: 10, duration: 60_000 }, // Rate limit: 10 jobs/phút
  }
);

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err: err.message }, 'Job failed');
});

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, result }, 'Job completed');
});
