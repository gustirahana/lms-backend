import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a loopback port');
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  return address.port;
}

async function run(): Promise<void> {
  const port = await unusedLoopbackPort();
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: 'ignore',
  });

  try {
    let response: Response | undefined;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error('Compiled production entrypoint exited before serving health');
      }

      try {
        response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(500),
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    assert.ok(response, 'Compiled production entrypoint did not become ready on loopback');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'learning-platform-api' });
    console.log('Production-entrypoint smoke passed: dist/main.js served health on loopback.');
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
