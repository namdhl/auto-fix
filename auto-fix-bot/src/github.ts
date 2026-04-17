import { App } from '@octokit/app';

export const githubApp = new App({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, '\n'),
});

export async function getOctokit(installationId: number) {
  return githubApp.getInstallationOctokit(installationId);
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const auth = (await githubApp.octokit.auth({
    type: 'installation',
    installationId,
  })) as { token: string };
  return auth.token;
}

export async function downloadWorkflowLogs(
  installationId: number,
  owner: string,
  repo: string,
  runId: number
): Promise<Buffer> {
  const octokit = await getOctokit(installationId);
  const res = await octokit.request(
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs',
    { owner, repo, run_id: runId }
  );
  return Buffer.from(res.data as ArrayBuffer);
}

export async function createPullRequest(
  installationId: number,
  owner: string,
  repo: string,
  opts: {
    title: string;
    head: string;
    base: string;
    body: string;
  }
) {
  const octokit = await getOctokit(installationId);
  const { data } = await octokit.rest.pulls.create({ owner, repo, ...opts });
  return data;
}

export async function createIssue(
  installationId: number,
  owner: string,
  repo: string,
  opts: {
    title: string;
    body: string;
    labels?: string[];
  }
) {
  const octokit = await getOctokit(installationId);
  const { data } = await octokit.rest.issues.create({ owner, repo, ...opts });
  return data;
}

export async function mergePullRequest(
  installationId: number,
  owner: string,
  repo: string,
  pullNumber: number
) {
  const octokit = await getOctokit(installationId);
  const { data } = await octokit.rest.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: 'squash',
  });
  return data;
}

export async function getCheckRunsForRef(
  installationId: number,
  owner: string,
  repo: string,
  ref: string
) {
  const octokit = await getOctokit(installationId);
  const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref });
  return data.check_runs;
}
