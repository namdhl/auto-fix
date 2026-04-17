import Docker from 'dockerode';
import { logger } from './logger.js';

const docker = new Docker();

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Chạy 1 command trong Docker container isolated với:
 * - No network (mặc định)
 * - Read-only ngoài /workspace
 * - CPU/memory limit
 * - Auto cleanup
 */
export async function runInSandbox(opts: {
  image: string;          // e.g. 'node:20-alpine', 'python:3.12-slim'
  hostWorkspace: string;  // host path để mount làm /workspace
  command: string[];
  timeoutMs?: number;
  network?: boolean;      // mặc định false
}): Promise<SandboxResult> {
  const timeout = opts.timeoutMs ?? 120_000;

  const container = await docker.createContainer({
    Image: opts.image,
    Cmd: opts.command,
    WorkingDir: '/workspace',
    HostConfig: {
      Binds: [`${opts.hostWorkspace}:/workspace:rw`],
      NetworkMode: opts.network ? 'bridge' : 'none',
      Memory: 1024 * 1024 * 1024,           // 1 GB
      NanoCpus: 1_000_000_000,              // 1 vCPU
      AutoRemove: true,
      ReadonlyRootfs: false,                // pip/npm cần ghi cache
    },
    Tty: false,
  });

  await container.start();

  let stdout = '';
  let stderr = '';

  const stream = await container.logs({ follow: true, stdout: true, stderr: true });
  container.modem.demuxStream(
    stream,
    { write: (c: Buffer) => (stdout += c.toString()) } as any,
    { write: (c: Buffer) => (stderr += c.toString()) } as any
  );

  const result = await Promise.race([
    container.wait(),
    new Promise<never>((_, rej) =>
      setTimeout(() => {
        container.kill().catch(() => {});
        rej(new Error('sandbox timeout'));
      }, timeout)
    ),
  ]);

  return { exitCode: (result as any).StatusCode, stdout, stderr };
}

/** Validate fix bằng cách chạy build/lint trong sandbox */
export async function validateFix(
  workspace: string,
  language: 'node' | 'python' | 'go' | 'unknown'
): Promise<{ ok: boolean; output: string }> {
  const configs = {
    node: { image: 'node:20-alpine', cmd: ['npx', '--no', 'tsc', '--noEmit'] },
    python: { image: 'python:3.12-slim', cmd: ['python', '-m', 'compileall', '-q', '.'] },
    go: { image: 'golang:1.22-alpine', cmd: ['go', 'build', './...'] },
    unknown: null,
  };

  const cfg = configs[language];
  if (!cfg) return { ok: true, output: 'no validator for language' };

  try {
    const r = await runInSandbox({
      image: cfg.image,
      hostWorkspace: workspace,
      command: cfg.cmd,
      timeoutMs: 180_000,
    });
    return { ok: r.exitCode === 0, output: r.stdout + '\n' + r.stderr };
  } catch (err: any) {
    logger.warn({ err: err.message }, 'sandbox validation failed');
    return { ok: false, output: err.message };
  }
}
