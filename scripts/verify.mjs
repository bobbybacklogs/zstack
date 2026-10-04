#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const EXIT = { OK: 0, FAIL: 1, USAGE: 2 };

const HERMETIC_FILES = [
  'tests/api.test.mjs',
  'tests/blocks.test.mjs',
  'tests/budget.test.mjs',
  'tests/chat.test.mjs',
  'tests/chats.test.mjs',
  'tests/classify.test.mjs',
  'tests/cli-json.test.mjs',
  'tests/context.test.mjs',
  'tests/grader.test.mjs',
  'tests/github.test.mjs',
  'tests/git.test.mjs',
  'tests/git-races.test.mjs',
  'tests/harness.test.mjs',
  'tests/history.test.mjs',
  'tests/manifest.test.mjs',
  'tests/optimize.test.mjs',
  'tests/overrides.test.mjs',
  'tests/projects.test.mjs',
  'tests/router.test.mjs',
  'tests/runs.test.mjs',
  'tests/schedules.test.mjs',
  'tests/schedules_cli.test.mjs',
  'tests/server.test.mjs',
  'tests/shell.test.mjs',
  'tests/skill.test.mjs',
  'tests/subagent.test.mjs',
  'tests/triage.test.mjs',
  'tests/turns.test.mjs',
  'tests/workfolk.test.mjs'
];

const CONNECTOR_FILE = 'tests/connector.test.mjs';
const CONNECTOR_HERMETIC_PATTERN = 'gateway failure hardening';

function parseTAP(stdout) {
  const grab = re => {
    const m = stdout.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    tests: grab(/# tests (\d+)/),
    pass: grab(/# pass (\d+)/),
    fail: grab(/# fail (\d+)/),
    skipped: grab(/# skipped (\d+)/)
  };
}

function runNode(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: EXIT.FAIL, stdout, stderr: String(err) }));
  });
}

async function runSuite(name, files, pattern) {
  // The TAP reporter is requested explicitly. Node's default reporter became
  // `spec` in Node 20, which emits `ℹ pass 20` rather than `# pass 20`, so
  // relying on the default made every count parse as zero and reported a
  // passing suite as a failure.
  const args = ['--test', '--test-reporter=tap'];
  if (pattern) args.push('--test-name-pattern', pattern);
  args.push(...files);
  const { code, stdout, stderr } = await runNode(args);
  const counts = parseTAP(stdout);
  const failed = code !== 0 || (counts.fail ?? 1) > 0;
  return { name, code, failed, counts, stdout, stderr, files: files.join(' ') };
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const live = argv.includes('--live') || argv.includes('-l');
  const help = argv.includes('--help') || argv.includes('-h');

  if (help) {
    console.log('zstack verify');
    console.log('  npm run verify          hermetic default (no secrets, no live gateway, loopback stubs only)');
    console.log('  npm run verify:live     also run live ModelHitch bridge and upstream network canaries');
    console.log('  node scripts/verify.mjs --json   emit machine-readable evidence');
    console.log('Exit codes: 0 all covered checks pass · 1 at least one covered check failed · 2 usage');
    process.exit(EXIT.OK);
  }

  const suites = [];
  suites.push(await runSuite('hermetic unit suites', HERMETIC_FILES));
  suites.push(await runSuite('connector (hermetic: gateway failure hardening)', [CONNECTOR_FILE], CONNECTOR_HERMETIC_PATTERN));

  if (live) {
    suites.push(await runSuite('LIVE canaries: connector live gateway + upstream network', [CONNECTOR_FILE]));
  }

  const covered = suites.filter(s => !s.name.startsWith('LIVE'));
  const coveredFailed = covered.filter(s => s.failed);
  const liveFailed = suites.filter(s => s.name.startsWith('LIVE') && s.failed);

  const doc = {
    timestamp: new Date().toISOString(),
    task: 'zstack feature map verification',
    status: coveredFailed.length > 0 ? 'failed' : liveFailed.length > 0 ? 'partially_verified' : 'passed',
    checks: suites.map(s => ({
      name: s.name,
      command: `node --test [${s.files || ''}]`,
      passed: !s.failed,
      exitCode: s.code,
      passedTests: s.counts?.pass ?? 0,
      failedTests: s.counts?.fail ?? 0,
      skippedTests: s.counts?.skipped ?? 0,
      totalTests: s.counts?.tests ?? 0
    }))
  };

  if (json) {
    console.log(JSON.stringify(doc, null, 2));
  } else {
    let totalPass = 0;
    let totalFail = 0;
    for (const s of suites) {
      const mark = s.failed ? 'FAIL' : s.name.startsWith('LIVE') ? 'SKIP/OK' : 'ok';
      console.log(`${mark.padEnd(7)} ${s.name}: ${s.counts?.pass ?? 0} passed, ${s.counts?.fail ?? 0} failed, ${s.counts?.skipped ?? 0} skipped`);
      totalPass += s.counts?.pass ?? 0;
      totalFail += s.counts?.fail ?? 0;
      if (s.failed) {
        const failSection = s.stdout.split('\n').filter(l => l.includes('not ok') || l.includes('failureType:'));
        for (const line of failSection.slice(0, 12)) {
          console.log(`    ${line.trim()}`);
        }
      }
    }
    console.log('---');
    console.log(`Total: ${totalPass} passed, ${totalFail} failed`);
    if (liveFailed.length > 0) {
      console.log('NOTE: live canaries failed: ModelHitch bridge or network unavailable. This does NOT fail the hermetic default.');
    }
  }

  process.exit(coveredFailed.length > 0 ? EXIT.FAIL : EXIT.OK);
}

main().catch(err => {
  console.error(`verify runner error: ${err.message}`);
  process.exit(EXIT.USAGE);
});
