import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateCron,
  computeNextRun,
  describeCron,
  inferScheduleFromText,
  readSchedules,
  writeSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  findSchedule,
  Scheduler
} from '../src/schedules.mjs';

const tempDirs = [];
function tmpSchedules() {
  const dir = mkdtempSync(join(tmpdir(), 'zstack-sched-'));
  tempDirs.push(dir);
  return join(dir, 'schedules.json');
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tempDirs.length = 0;
});

describe('Cron parsing & validation', () => {
  it('validates standard 5-part cron expressions', () => {
    assert.equal(validateCron('0 9 * * 1-5').valid, true);
    assert.equal(validateCron('*/15 0-23 1,15 * *').valid, true);
    assert.equal(validateCron('0 0 * * 0').valid, true);
  });

  it('supports cron shorthands', () => {
    const hourly = validateCron('@hourly');
    assert.equal(hourly.valid, true);
    assert.equal(hourly.canonical, '0 * * * *');

    const daily = validateCron('@daily');
    assert.equal(daily.valid, true);
    assert.equal(daily.canonical, '0 0 * * *');

    const workdays = validateCron('@workdays');
    assert.equal(workdays.valid, true);
    assert.equal(workdays.canonical, '0 9 * * 1-5');
  });

  it('rejects invalid fields and field counts', () => {
    assert.equal(validateCron('0 9 * *').valid, false);
    assert.equal(validateCron('0 9 * * * *').valid, false);
    assert.equal(validateCron('60 9 * * *').valid, false);
    assert.equal(validateCron('0 25 * * *').valid, false);
    assert.equal(validateCron('0 9 32 * *').valid, false);
    assert.equal(validateCron('0 9 * 13 *').valid, false);
    assert.equal(validateCron('0 9 * * 8').valid, false);
    assert.equal(validateCron('*/0 * * * *').valid, false);
    assert.equal(validateCron('5-2 * * * *').valid, false);
  });

  it('computes next scheduled run correctly', () => {
    // Starting on a Monday at 08:30: next run of "0 9 * * 1-5" is Monday at 09:00
    const mondayMorning = new Date(2026, 9, 5, 8, 30, 0); // Oct 5 2026 is Monday
    const next1 = computeNextRun('0 9 * * 1-5', mondayMorning);
    assert.equal(next1.getDay(), 1); // Monday
    assert.equal(next1.getHours(), 9);
    assert.equal(next1.getMinutes(), 0);

    // Starting on a Friday at 10:00: next run of "0 9 * * 1-5" is Monday at 09:00
    const fridayAfternoon = new Date(2026, 9, 9, 10, 0, 0); // Oct 9 2026 is Friday
    const next2 = computeNextRun('0 9 * * 1-5', fridayAfternoon);
    assert.equal(next2.getDay(), 1); // Monday
    assert.equal(next2.getDate(), 12); // Oct 12 2026
    assert.equal(next2.getHours(), 9);
    assert.equal(next2.getMinutes(), 0);

    // Hourly check
    const atTenFifteen = new Date(2026, 9, 5, 10, 15, 0);
    const nextHourly = computeNextRun('@hourly', atTenFifteen);
    assert.equal(nextHourly.getHours(), 11);
    assert.equal(nextHourly.getMinutes(), 0);
  });

  it('describes common cron expressions in human terms', () => {
    assert.equal(describeCron('0 * * * *'), 'Hourly (at minute 0)');
    assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00');
    assert.equal(describeCron('0 8 * * *'), 'Daily at 08:00');
    assert.equal(describeCron('*/15 * * * *'), 'Every 15 minutes');
    assert.equal(describeCron('0 */2 * * *'), 'Every 2 hours');
  });
});

describe('Routine Inference from Prompts', () => {
  it('infers morning cadence', () => {
    const res = inferScheduleFromText('Every morning at 9am check for open PRs and run tests');
    assert.equal(res.matched, true);
    assert.equal(res.cron, '0 9 * * *');
    assert.equal(res.cleanedPrompt, 'Check for open PRs and run tests');
  });

  it('infers default morning cadence without explicit time', () => {
    const res = inferScheduleFromText('Every morning review test failures');
    assert.equal(res.matched, true);
    assert.equal(res.cron, '0 8 * * *');
    assert.equal(res.cleanedPrompt, 'Review test failures');
  });

  it('infers nightly cadence', () => {
    const res = inferScheduleFromText('Nightly at 2:30am: clean up scratch files');
    assert.equal(res.matched, true);
    assert.equal(res.cron, '30 2 * * *');
    assert.equal(res.cleanedPrompt, 'Clean up scratch files');
  });

  it('infers weekday cadence', () => {
    const res = inferScheduleFromText('Every weekday at 10am summarize sprint blockers');
    assert.equal(res.matched, true);
    assert.equal(res.cron, '0 10 * * 1-5');
    assert.equal(res.cleanedPrompt, 'Summarize sprint blockers');
  });

  it('infers hourly interval cadence', () => {
    const res = inferScheduleFromText('Every 4 hours check server health');
    assert.equal(res.matched, true);
    assert.equal(res.cron, '0 */4 * * *');
    assert.equal(res.cleanedPrompt, 'Check server health');
  });

  it('infers direct cron expression prefix', () => {
    const res = inferScheduleFromText('0 9 * * 1-5 run security scan');
    assert.equal(res.matched, true);
    assert.equal(res.cron, '0 9 * * 1-5');
    assert.equal(res.cleanedPrompt, 'Run security scan');
  });

  it('returns matched=false for plain prompts', () => {
    const res = inferScheduleFromText('Please refactor the database connector');
    assert.equal(res.matched, false);
    assert.equal(res.cleanedPrompt, 'Please refactor the database connector');
  });
});

describe('Schedule Storage & CRUD', () => {
  it('creates, reads, updates, and deletes schedules', () => {
    const p = tmpSchedules();

    // Empty at start
    const initial = readSchedules(p);
    assert.equal(initial.schedules.length, 0);

    // Create
    const created = createSchedule({
      name: 'PR Digest',
      cron: '0 9 * * 1-5',
      prompt: 'Check PRs',
      policy: 'read-only'
    }, p);

    assert.ok(created.id.startsWith('sched-'));
    assert.equal(created.name, 'PR Digest');
    assert.equal(created.enabled, true);
    assert.ok(created.nextRunAt);

    // Find
    const found = findSchedule(created.id, p);
    assert.equal(found.id, created.id);
    assert.equal(found.prompt, 'Check PRs');

    // Update
    const updated = updateSchedule(created.id, {
      name: 'PR Digest (Updated)',
      cron: '0 10 * * 1-5',
      policy: 'apply'
    }, p);
    assert.equal(updated.name, 'PR Digest (Updated)');
    assert.equal(updated.cron, '0 10 * * 1-5');
    assert.equal(updated.policy, 'apply');

    // Delete
    const deleted = deleteSchedule(created.id, p);
    assert.equal(deleted, true);

    const afterDelete = readSchedules(p);
    assert.equal(afterDelete.schedules.length, 0);
  });

  it('tolerates missing and corrupted storage files', () => {
    const p = tmpSchedules();
    writeFileSync(p, '{ bad json ]', 'utf8');

    const res = readSchedules(p);
    assert.equal(res.corrupted, true);
    assert.deepEqual(res.schedules, []);

    // Writing recovers from corruption
    createSchedule({ prompt: 'Rescue prompt' }, p);
    const recovered = readSchedules(p);
    assert.equal(recovered.corrupted, false);
    assert.equal(recovered.schedules.length, 1);
  });
});

describe('Scheduler Engine', () => {
  it('triggers due schedules and updates nextRunAt and lastRunAt', async () => {
    const p = tmpSchedules();
    const calls = [];
    const mockRegistry = {
      start(request) {
        calls.push(request);
        return { id: 'run-test-123' };
      }
    };

    const scheduler = new Scheduler({
      schedulesPath: p,
      registry: mockRegistry,
      admitRun: async (ws, activate) => activate()
    });

    const now = new Date();
    // Create schedule with nextRunAt set in the past so it is immediately due
    const past = new Date(now.getTime() - 60000);
    const sched = createSchedule({
      name: 'Health Audit',
      cron: '0 9 * * 1-5',
      prompt: 'Check system health',
      policy: 'read-only'
    }, p);

    updateSchedule(sched.id, { nextRunAt: past.toISOString() }, p);

    // Run tick
    const results = await scheduler.tick(now);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'triggered');
    assert.equal(results[0].runId, 'run-test-123');

    // Verify registry received request
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, 'Check system health');
    assert.equal(calls[0].policy, 'read-only');
    assert.equal(calls[0].trigger, 'schedule');
    assert.equal(calls[0].scheduleId, sched.id);

    // Verify schedule was updated with nextRunAt in the future and lastRunAt set
    const updated = findSchedule(sched.id, p);
    assert.equal(updated.lastRunId, 'run-test-123');
    assert.equal(updated.lastStatus, 'triggered');
    assert.ok(new Date(updated.nextRunAt).getTime() > now.getTime());
  });

  it('skips disabled schedules', async () => {
    const p = tmpSchedules();
    const calls = [];
    const scheduler = new Scheduler({
      schedulesPath: p,
      registry: { start: (req) => { calls.push(req); return { id: 'run-x' }; } },
      admitRun: async (ws, activate) => activate()
    });

    const now = new Date();
    const sched = createSchedule({
      prompt: 'Disabled task',
      enabled: false
    }, p);
    updateSchedule(sched.id, { nextRunAt: new Date(now.getTime() - 1000).toISOString() }, p);

    const results = await scheduler.tick(now);
    assert.equal(results.length, 0);
    assert.equal(calls.length, 0);
  });

  it('records skipped-busy status when repository is busy', async () => {
    const p = tmpSchedules();
    const scheduler = new Scheduler({
      schedulesPath: p,
      registry: { start: () => ({ id: 'run-x' }) },
      admitRun: async () => {
        const err = new Error('A run is already active in this repository.');
        err.kind = 'git-repo-busy';
        throw err;
      }
    });

    const now = new Date();
    const sched = createSchedule({ prompt: 'Busy task' }, p);
    updateSchedule(sched.id, { nextRunAt: new Date(now.getTime() - 1000).toISOString() }, p);

    const results = await scheduler.tick(now);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'skipped-busy');

    const updated = findSchedule(sched.id, p);
    assert.equal(updated.lastStatus, 'skipped-busy');
    assert.ok(new Date(updated.nextRunAt).getTime() > now.getTime());
  });
});
