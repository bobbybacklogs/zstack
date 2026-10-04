import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'bin', 'zstack.mjs');

const run = promisify(execFile);

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env }
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('zstack schedule CLI', () => {
  let tempDir;
  let schedulesFile;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'zstack-cli-sched-'));
    schedulesFile = join(tempDir, 'schedules.json');
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lists empty schedules cleanly in human text and json', async () => {
    const rText = await runCli(['schedule', 'list'], { ZSTACK_SCHEDULES_PATH: schedulesFile });
    assert.equal(rText.code, 0);
    assert.match(rText.stdout, /No routines scheduled yet/);

    const rJson = await runCli(['schedule', 'list', '--json'], { ZSTACK_SCHEDULES_PATH: schedulesFile });
    assert.equal(rJson.code, 0);
    const doc = JSON.parse(rJson.stdout);
    assert.equal(doc.ok, true);
    assert.equal(doc.count, 0);
    assert.deepEqual(doc.schedules, []);
  });

  it('infers routine cadence from natural language in human text and json', async () => {
    const rText = await runCli(['schedule', 'infer', 'every morning at 9am check pull requests']);
    assert.equal(rText.code, 0);
    assert.match(rText.stdout, /Every morning at 09:00/);
    assert.match(rText.stdout, /0 9 \* \* \*/);
    assert.match(rText.stdout, /Check pull requests/);

    const rJson = await runCli(['schedule', 'infer', 'every 3 hours run health checks', '--json']);
    assert.equal(rJson.code, 0);
    const doc = JSON.parse(rJson.stdout);
    assert.equal(doc.ok, true);
    assert.equal(doc.inferred.matched, true);
    assert.equal(doc.inferred.cron, '0 */3 * * *');
    assert.equal(doc.inferred.cleanedPrompt, 'Run health checks');
  });

  it('adds routine by inferring schedule from prompt', async () => {
    const r = await runCli(['schedule', 'add', 'every weekday at 9am run daily checks', '--json'], {
      ZSTACK_SCHEDULES_PATH: schedulesFile
    });
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, true);
    assert.ok(doc.schedule.id);
    assert.equal(doc.schedule.cron, '0 9 * * 1-5');
    assert.equal(doc.schedule.prompt, 'Run daily checks');
    assert.equal(doc.schedule.enabled, true);
    assert.equal(doc.schedule.policy, 'read-only');
    assert.ok(doc.schedule.nextRunAt);
  });

  it('adds routine with explicit --cron and --policy apply', async () => {
    const r = await runCli([
      'schedule', 'add', 'clean up temp caches',
      '--cron', '0 2 * * *',
      '--name', 'Nightly cache cleanup',
      '--policy', 'apply',
      '--json'
    ], { ZSTACK_SCHEDULES_PATH: schedulesFile });

    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, true);
    assert.equal(doc.schedule.name, 'Nightly cache cleanup');
    assert.equal(doc.schedule.cron, '0 2 * * *');
    assert.equal(doc.schedule.policy, 'apply');
  });

  it('fails with usage error if no schedule is inferred and no --cron is given', async () => {
    const r = await runCli(['schedule', 'add', 'do something random with no cadence'], {
      ZSTACK_SCHEDULES_PATH: schedulesFile
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /No schedule detected/);
  });

  it('enables, disables, and deletes scheduled routines', async () => {
    // 1. Add
    const rAdd = await runCli(['schedule', 'add', 'every hour sync mirrors', '--json'], {
      ZSTACK_SCHEDULES_PATH: schedulesFile
    });
    const { schedule } = JSON.parse(rAdd.stdout);
    const id = schedule.id;

    // 2. Disable
    const rDis = await runCli(['schedule', 'disable', id, '--json'], {
      ZSTACK_SCHEDULES_PATH: schedulesFile
    });
    assert.equal(rDis.code, 0);
    const disDoc = JSON.parse(rDis.stdout);
    assert.equal(disDoc.enabled, false);

    // 3. Enable
    const rEn = await runCli(['schedule', 'enable', id, '--json'], {
      ZSTACK_SCHEDULES_PATH: schedulesFile
    });
    assert.equal(rEn.code, 0);
    const enDoc = JSON.parse(rEn.stdout);
    assert.equal(enDoc.enabled, true);
    assert.ok(enDoc.nextRunAt);

    // 4. Delete
    const rDel = await runCli(['schedule', 'delete', id, '--json'], {
      ZSTACK_SCHEDULES_PATH: schedulesFile
    });
    assert.equal(rDel.code, 0);
    const delDoc = JSON.parse(rDel.stdout);
    assert.equal(delDoc.deleted, id);

    // 5. Verify list is empty again
    const rList = await runCli(['schedule', 'list', '--json'], {
      ZSTACK_SCHEDULES_PATH: schedulesFile
    });
    const listDoc = JSON.parse(rList.stdout);
    assert.equal(listDoc.count, 0);
  });

  it('prints schedule help and usage in main help output', async () => {
    const r = await runCli(['help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /zstack schedule list/);
    assert.match(r.stdout, /zstack schedule add/);
    assert.match(r.stdout, /--cron "<expr>"/);
  });
});
