/**
 * Scheduled agent execution (cron routines) for zstack.
 *
 * Provides storage, zero-dependency cron and natural cadence parsing, routine
 * inference from prompts, and the daemon scheduler that drives unattended runs
 * through zstack serve's RunRegistry with concurrency and repo safety.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export function schedulesPath(pathOverride) {
  return (
    pathOverride ||
    process.env.ZSTACK_SCHEDULES_PATH ||
    join(homedir(), '.zstack', 'schedules.json')
  );
}

/** A short, stable id for a schedule. */
export function newScheduleId() {
  return `sched-${randomBytes(6).toString('hex')}`;
}

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

const DAY_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

export const CRON_SHORTHANDS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@workdays': '0 9 * * 1-5',
  '@weekdays': '0 9 * * 1-5',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
};

/**
 * Parse one field in a cron expression (e.g. "1-5", step patterns, "1,2,5").
 */
function parseField(str, min, max, nameMap = null) {
  const values = new Set();
  const subparts = String(str).split(',');

  for (const sub of subparts) {
    const trimmed = sub.trim().toLowerCase();
    if (!trimmed) {
      throw new Error(`Empty sub-expression in cron field "${str}".`);
    }

    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    if (trimmed.startsWith('*/')) {
      const step = parseInt(trimmed.slice(2), 10);
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Invalid step value in "${trimmed}".`);
      }
      for (let i = min; i <= max; i += step) values.add(i);
      continue;
    }

    if (trimmed.includes('-')) {
      const [rangePart, stepPart] = trimmed.split('/');
      const [startStr, endStr] = rangePart.split('-');
      const step = stepPart ? parseInt(stepPart, 10) : 1;
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Invalid step value in "${trimmed}".`);
      }

      let start = nameMap && nameMap[startStr] !== undefined ? nameMap[startStr] : parseInt(startStr, 10);
      let end = nameMap && nameMap[endStr] !== undefined ? nameMap[endStr] : parseInt(endStr, 10);

      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error(`Invalid range "${trimmed}".`);
      }
      if (start > end) {
        throw new Error(`Range start ${start} cannot exceed end ${end} in "${trimmed}".`);
      }
      if (start < min || end > max) {
        throw new Error(`Range ${start}-${end} out of bounds [${min}-${max}].`);
      }

      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    let val = nameMap && nameMap[trimmed] !== undefined ? nameMap[trimmed] : parseInt(trimmed, 10);
    if (!Number.isInteger(val)) {
      throw new Error(`Invalid value "${trimmed}".`);
    }
    if (val < min || val > max) {
      throw new Error(`Value ${val} out of bounds [${min}-${max}].`);
    }
    values.add(val);
  }

  return values;
}

/**
 * Validate and parse a standard 5-field cron expression or shorthand.
 */
export function validateCron(expr) {
  if (typeof expr !== 'string' || !expr.trim()) {
    return { valid: false, error: 'Cron expression must be a non-empty string.' };
  }

  const raw = expr.trim();
  const canonical = CRON_SHORTHANDS[raw.toLowerCase()] || raw;
  const parts = canonical.split(/\s+/).filter(Boolean);

  if (parts.length !== 5) {
    return {
      valid: false,
      error: `Cron expression must contain exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts.length} in "${raw}".`
    };
  }

  try {
    const minutes = parseField(parts[0], 0, 59);
    const hours = parseField(parts[1], 0, 23);
    const daysOfMonth = parseField(parts[2], 1, 31);
    const months = parseField(parts[3], 1, 12, MONTH_NAMES);

    // Days of week (0-7, 7 = 0 = Sunday)
    const rawDows = parseField(parts[4], 0, 7, DAY_NAMES);
    const daysOfWeek = new Set();
    for (const d of rawDows) {
      daysOfWeek.add(d === 7 ? 0 : d);
    }

    return {
      valid: true,
      canonical,
      parsed: {
        minutes,
        hours,
        daysOfMonth,
        months,
        daysOfWeek,
        isDomWildcard: parts[2] === '*',
        isDowWildcard: parts[4] === '*'
      }
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Compute the next scheduled execution Date after `fromDate`.
 */
export function computeNextRun(cronExpr, fromDate = new Date()) {
  const { valid, canonical, parsed, error } = validateCron(cronExpr);
  if (!valid) throw new Error(error);

  const start = new Date(fromDate.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const maxYear = start.getFullYear() + 5;

  while (start.getFullYear() <= maxYear) {
    const month = start.getMonth() + 1;
    if (!parsed.months.has(month)) {
      start.setMonth(start.getMonth() + 1, 1);
      start.setHours(0, 0, 0, 0);
      continue;
    }

    const dom = start.getDate();
    const dow = start.getDay();

    const domMatch = parsed.daysOfMonth.has(dom);
    const dowMatch = parsed.daysOfWeek.has(dow);

    let dayMatch = false;
    if (parsed.isDomWildcard && parsed.isDowWildcard) {
      dayMatch = true;
    } else if (parsed.isDomWildcard && !parsed.isDowWildcard) {
      dayMatch = dowMatch;
    } else if (!parsed.isDomWildcard && parsed.isDowWildcard) {
      dayMatch = domMatch;
    } else {
      // If both DOM and DOW are specified, standard POSIX cron matches if either matches
      dayMatch = domMatch || dowMatch;
    }

    if (!dayMatch) {
      start.setDate(start.getDate() + 1);
      start.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = start.getHours();
    if (!parsed.hours.has(hour)) {
      start.setHours(start.getHours() + 1, 0, 0, 0);
      continue;
    }

    const minute = start.getMinutes();
    if (!parsed.minutes.has(minute)) {
      start.setMinutes(start.getMinutes() + 1);
      continue;
    }

    return new Date(start.getTime());
  }

  throw new Error(`No matching execution time found within 5 years for cron "${cronExpr}".`);
}

/**
 * Human description of a cron expression.
 */
export function describeCron(cronExpr) {
  const raw = String(cronExpr ?? '').trim();
  const canonical = CRON_SHORTHANDS[raw.toLowerCase()] || raw;
  const parts = canonical.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return raw;

  const [m, h, dom, mon, dow] = parts;
  if (canonical === '0 * * * *') return 'Hourly (at minute 0)';
  if (canonical === '0 0 * * *') return 'Daily at midnight (00:00)';
  if (canonical === '0 8 * * *') return 'Daily at 08:00';
  if (canonical === '0 9 * * 1-5') return 'Weekdays at 09:00';
  if (canonical === '0 0 * * 0') return 'Weekly on Sunday at 00:00';

  if (m === '0' && h.match(/^\d+$/) && dom === '*' && mon === '*' && dow === '*') {
    const hh = h.padStart(2, '0');
    return `Daily at ${hh}:00`;
  }
  if (m.match(/^\d+$/) && h.match(/^\d+$/) && dom === '*' && mon === '*' && dow === '*') {
    const hh = h.padStart(2, '0');
    const mm = m.padStart(2, '0');
    return `Daily at ${hh}:${mm}`;
  }
  if (m.match(/^\d+$/) && h.match(/^\d+$/) && dom === '*' && mon === '*' && dow === '1-5') {
    const hh = h.padStart(2, '0');
    const mm = m.padStart(2, '0');
    return `Weekdays at ${hh}:${mm}`;
  }
  if (m.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${m.slice(2)} minutes`;
  }
  if (m === '0' && h.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${h.slice(2)} hours`;
  }

  return `Cron: ${canonical}`;
}

/**
 * Parse an optional 12-hour or 24-hour time string into { hour, minute }.
 */
function parseTimeString(timeStr, defaultHour = 9, defaultMinute = 0) {
  if (!timeStr) return { hour: defaultHour, minute: defaultMinute };
  const match = timeStr.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return { hour: defaultHour, minute: defaultMinute };

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3] ? match[3].toLowerCase() : null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: defaultHour, minute: defaultMinute };
  }
  return { hour, minute };
}

/**
 * Infer a scheduled routine and cron expression from a prompt or chat text.
 * Extracts the cadence and produces a cleaned task prompt without schedule boilerplate.
 */
export function inferScheduleFromText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { matched: false, cleanedPrompt: '' };

  // 1. Direct leading cron expression: "0 9 * * 1-5 <prompt>"
  const directCron = raw.match(/^([0-9*,/-]+(?:\s+[0-9*,/-]+){4})\s+([\s\S]+)$/);
  if (directCron) {
    const expr = directCron[1];
    const { valid } = validateCron(expr);
    if (valid) {
      return {
        matched: true,
        cron: expr,
        humanCadence: describeCron(expr),
        cleanedPrompt: cleanPrompt(directCron[2])
      };
    }
  }

  // 2. "every N minutes / every minute"
  const minMatch = raw.match(/^(?:please\s+)?every\s+(\d+)\s*minutes?(?:\s*[:,-]|\s+to|\s+and)?\s+([\s\S]+)$/i);
  if (minMatch) {
    const n = parseInt(minMatch[1], 10);
    const cron = n === 1 ? '* * * * *' : `*/${n} * * * *`;
    return {
      matched: true,
      cron,
      humanCadence: n === 1 ? 'Every minute' : `Every ${n} minutes`,
      cleanedPrompt: cleanPrompt(minMatch[2])
    };
  }

  const oneMinMatch = raw.match(/^(?:please\s+)?every\s+minute(?:\s*[:,-]|\s+to|\s+and)?\s+([\s\S]+)$/i);
  if (oneMinMatch) {
    return {
      matched: true,
      cron: '* * * * *',
      humanCadence: 'Every minute',
      cleanedPrompt: cleanPrompt(oneMinMatch[1])
    };
  }

  // 3. "every N hours / every hour"
  const hourMatch = raw.match(/^(?:please\s+)?every\s+(\d+)\s*hours?(?:\s*[:,-]|\s+to|\s+and)?\s+([\s\S]+)$/i);
  if (hourMatch) {
    const n = parseInt(hourMatch[1], 10);
    const cron = `0 */${n} * * *`;
    return {
      matched: true,
      cron,
      humanCadence: `Every ${n} hours`,
      cleanedPrompt: cleanPrompt(hourMatch[2])
    };
  }

  const oneHourMatch = raw.match(/^(?:please\s+)?every\s+hour(?:\s*[:,-]|\s+to|\s+and)?\s+([\s\S]+)$/i);
  if (oneHourMatch) {
    return {
      matched: true,
      cron: '0 * * * *',
      humanCadence: 'Hourly (at minute 0)',
      cleanedPrompt: cleanPrompt(oneHourMatch[1])
    };
  }

  // 4. "every morning [at <time>]"
  const morningMatch = raw.match(/^(?:please\s+)?every\s+morning(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?(?:\s*[:,-]|\s+to|\s+and)?\s+([\s\S]+)$/i);
  if (morningMatch) {
    const { hour, minute } = parseTimeString(morningMatch[1], 8, 0);
    const cron = `${minute} ${hour} * * *`;
    return {
      matched: true,
      cron,
      humanCadence: `Every morning at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      cleanedPrompt: cleanPrompt(morningMatch[2])
    };
  }

  // 5. "every night / nightly [at <time>]"
  const nightMatch = raw.match(/^(?:please\s+)?(?:every\s+night|nightly)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?(?:\s*[:,-]|\s+to|\s+and)?\s+([\s\S]+)$/i);
  if (nightMatch) {
    const { hour, minute } = parseTimeString(nightMatch[1], 2, 0);
    const cron = `${minute} ${hour} * * *`;
    return {
      matched: true,
      cron,
      humanCadence: `Nightly at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      cleanedPrompt: cleanPrompt(nightMatch[2])
    };
  }

  // 6. "every weekday / every workday [at <time>]"
  const weekdayMatch = raw.match(/^(?:please\s+)?every\s+(?:weekday|workday)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?(?:\s*[:,-]|\s+to|\s+and)?\s+([\s\S]+)$/i);
  if (weekdayMatch) {
    const { hour, minute } = parseTimeString(weekdayMatch[1], 9, 0);
    const cron = `${minute} ${hour} * * 1-5`;
    return {
      matched: true,
      cron,
      humanCadence: `Weekdays at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      cleanedPrompt: cleanPrompt(weekdayMatch[2])
    };
  }

  // 7. "every day at <time> / daily at <time>"
  const dailyMatch = raw.match(/^(?:please\s+)?(?:every\s+day|daily)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s*[:,-]|\s+to|\s+and)?\s+([\s\S]+)$/i);
  if (dailyMatch) {
    const { hour, minute } = parseTimeString(dailyMatch[1], 9, 0);
    const cron = `${minute} ${hour} * * *`;
    return {
      matched: true,
      cron,
      humanCadence: `Daily at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      cleanedPrompt: cleanPrompt(dailyMatch[2])
    };
  }

  // 8. "every (monday|tuesday|wednesday|thursday|friday|saturday|sunday) [at <time>]"
  const dayNameMatch = raw.match(/^(?:please\s+)?every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?(?:\s*[:,-]|\s+to|\s+and)?\s+([\s\S]+)$/i);
  if (dayNameMatch) {
    const dayName = dayNameMatch[1].toLowerCase().slice(0, 3);
    const dow = DAY_NAMES[dayName];
    const { hour, minute } = parseTimeString(dayNameMatch[2], 9, 0);
    const cron = `${minute} ${hour} * * ${dow}`;
    return {
      matched: true,
      cron,
      humanCadence: `Every ${dayNameMatch[1]} at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      cleanedPrompt: cleanPrompt(dayNameMatch[3])
    };
  }

  return { matched: false, cleanedPrompt: raw };
}

function cleanPrompt(str) {
  const trimmed = String(str ?? '').trim();
  if (!trimmed) return '';
  // Capitalize first letter if lowercase
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function normalizeSchedule(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (typeof item.id !== 'string' || item.id === '') return null;
  if (typeof item.prompt !== 'string' || item.prompt.trim() === '') return null;

  const cron = typeof item.cron === 'string' ? item.cron.trim() : '0 9 * * 1-5';
  const name = typeof item.name === 'string' && item.name.trim() !== ''
    ? item.name.trim()
    : (item.prompt.length > 50 ? `${item.prompt.slice(0, 47)}…` : item.prompt);

  return {
    id: item.id,
    name,
    cron,
    humanCadence: typeof item.humanCadence === 'string' ? item.humanCadence : describeCron(cron),
    prompt: item.prompt.trim(),
    projectId: typeof item.projectId === 'string' && item.projectId.trim() !== '' ? item.projectId.trim() : null,
    workspace: typeof item.workspace === 'string' && item.workspace.trim() !== '' ? item.workspace.trim() : null,
    playbook: typeof item.playbook === 'string' && item.playbook.trim() !== '' ? item.playbook.trim() : null,
    lane: typeof item.lane === 'string' && item.lane.trim() !== '' ? item.lane.trim() : null,
    policy: typeof item.policy === 'string' && item.policy.trim() !== '' ? item.policy.trim() : 'read-only',
    maxTurns: item.maxTurns !== undefined ? item.maxTurns : 25,
    enabled: item.enabled !== false,
    concurrency: item.concurrency === 'queue' ? 'queue' : 'skip',
    lastRunAt: typeof item.lastRunAt === 'string' ? item.lastRunAt : null,
    lastRunId: typeof item.lastRunId === 'string' ? item.lastRunId : null,
    lastStatus: typeof item.lastStatus === 'string' ? item.lastStatus : null,
    lastError: typeof item.lastError === 'string' ? item.lastError : null,
    nextRunAt: typeof item.nextRunAt === 'string' ? item.nextRunAt : null,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString()
  };
}

/**
 * Read all stored schedules, tolerating a missing or corrupt file.
 */
export function readSchedules(pathOverride) {
  const file = schedulesPath(pathOverride);
  if (!existsSync(file)) return { schedules: [], corrupted: false, path: file };

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { schedules: [], corrupted: true, path: file };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { schedules: [], corrupted: true, path: file };
  }

  const list = Array.isArray(parsed) ? parsed : parsed.schedules;
  if (!Array.isArray(list)) return { schedules: [], corrupted: true, path: file };

  const schedules = [];
  for (const item of list) {
    const s = normalizeSchedule(item);
    if (s) schedules.push(s);
  }

  return { schedules, corrupted: false, path: file };
}

/**
 * Write schedules to disk atomically.
 */
export function writeSchedules(schedules, pathOverride) {
  const file = schedulesPath(pathOverride);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, schedules }, null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try {
      if (existsSync(tmp)) renameSync(tmp, tmp + '.dead');
    } catch {}
    throw err;
  }
}

/**
 * Find a schedule by ID.
 */
export function findSchedule(id, pathOverride) {
  if (!id) return null;
  const { schedules } = readSchedules(pathOverride);
  return schedules.find((s) => s.id === id) || null;
}

/**
 * Validate input fields when creating or patching a schedule.
 */
export function validateScheduleInput(input, { isUpdate = false } = {}) {
  const problems = [];

  if (!isUpdate || input.prompt !== undefined) {
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
      problems.push('Prompt must be a non-empty string.');
    }
  }

  if (input.cron !== undefined) {
    const { valid, error } = validateCron(input.cron);
    if (!valid) {
      problems.push(error);
    }
  }

  if (input.name !== undefined && input.name !== null) {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      problems.push('Name must be a non-empty string.');
    }
  }

  if (input.policy !== undefined && input.policy !== null) {
    if (!['read-only', 'apply', 'strict'].includes(input.policy)) {
      problems.push('Policy must be one of: read-only, apply, strict.');
    }
  }

  if (input.concurrency !== undefined && input.concurrency !== null) {
    if (!['skip', 'queue'].includes(input.concurrency)) {
      problems.push('Concurrency must be one of: skip, queue.');
    }
  }

  return problems;
}

/**
 * Create a new scheduled routine.
 */
export function createSchedule(fields, pathOverride) {
  const problems = validateScheduleInput(fields);
  if (problems.length > 0) {
    const err = new Error(problems[0]);
    err.problems = problems;
    throw err;
  }

  const { schedules } = readSchedules(pathOverride);
  const now = new Date();
  const cron = typeof fields.cron === 'string' && fields.cron.trim() ? fields.cron.trim() : '0 9 * * 1-5';
  const nextRun = computeNextRun(cron, now);

  const newRecord = normalizeSchedule({
    id: fields.id || newScheduleId(),
    name: fields.name,
    cron,
    humanCadence: fields.humanCadence || describeCron(cron),
    prompt: fields.prompt,
    projectId: fields.projectId || fields.project || null,
    workspace: fields.workspace || fields.workspaceDir || null,
    playbook: fields.playbook || null,
    lane: fields.lane || null,
    policy: fields.policy || 'read-only',
    maxTurns: fields.maxTurns !== undefined ? fields.maxTurns : 25,
    enabled: fields.enabled !== false,
    concurrency: fields.concurrency || 'skip',
    lastRunAt: null,
    lastRunId: null,
    lastStatus: null,
    nextRunAt: nextRun.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });

  schedules.push(newRecord);
  writeSchedules(schedules, pathOverride);
  return newRecord;
}

/**
 * Update an existing scheduled routine.
 */
export function updateSchedule(id, patch, pathOverride) {
  const problems = validateScheduleInput(patch, { isUpdate: true });
  if (problems.length > 0) {
    const err = new Error(problems[0]);
    err.problems = problems;
    throw err;
  }

  const { schedules } = readSchedules(pathOverride);
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) return null;

  const current = schedules[idx];
  const now = new Date();

  let nextRunAt = current.nextRunAt;
  const cronChanged = patch.cron && patch.cron.trim() !== current.cron;
  if (cronChanged || (patch.enabled === true && !current.enabled)) {
    const targetCron = patch.cron ? patch.cron.trim() : current.cron;
    nextRunAt = computeNextRun(targetCron, now).toISOString();
  }

  const updated = normalizeSchedule({
    ...current,
    ...patch,
    id: current.id,
    nextRunAt: patch.nextRunAt !== undefined ? patch.nextRunAt : nextRunAt,
    updatedAt: now.toISOString()
  });

  schedules[idx] = updated;
  writeSchedules(schedules, pathOverride);
  return updated;
}

/**
 * Delete a scheduled routine by ID.
 */
export function deleteSchedule(id, pathOverride) {
  const { schedules } = readSchedules(pathOverride);
  const initialLen = schedules.length;
  const remaining = schedules.filter((s) => s.id !== id);
  if (remaining.length === initialLen) return false;

  writeSchedules(remaining, pathOverride);
  return true;
}

/**
 * Background scheduler daemon for zstack serve.
 */
export class Scheduler {
  constructor(options = {}) {
    this.schedulesPath = options.schedulesPath;
    this.admitRun = options.admitRun;
    this.registry = options.registry;
    this.findProject = options.findProject;
    this.projectsPath = options.projectsPath;
    this.tickIntervalMs = options.tickIntervalMs || 30000;
    this.timer = null;
    this.running = false;
    this.isTicking = false;
    this.onTrigger = options.onTrigger || null;
    this.onError = options.onError || null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        if (this.onError) this.onError(err);
      });
    }, this.tickIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one evaluation tick over stored schedules.
   */
  async tick(now = new Date()) {
    if (this.isTicking) return [];
    this.isTicking = true;
    const results = [];

    try {
      const { schedules } = readSchedules(this.schedulesPath);
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;

        let isDue = false;
        if (schedule.nextRunAt) {
          isDue = now.getTime() >= new Date(schedule.nextRunAt).getTime();
        } else {
          isDue = true;
        }

        if (isDue) {
          const outcome = await this.triggerSchedule(schedule, now);
          results.push({ scheduleId: schedule.id, ...outcome });
        }
      }
    } finally {
      this.isTicking = false;
    }

    return results;
  }

  /**
   * Trigger an execution for a single schedule.
   */
  async triggerSchedule(schedule, now = new Date()) {
    let resolvedWorkspace;
    let targetProjectId = undefined;

    if (schedule.projectId) {
      const project = typeof this.findProject === 'function'
        ? this.findProject(schedule.projectId, this.projectsPath)
        : null;
      if (project) {
        targetProjectId = project.id;
        resolvedWorkspace = project.dir;
      }
    }

    if (!resolvedWorkspace && schedule.workspace) {
      resolvedWorkspace = schedule.workspace;
    }

    const request = {
      prompt: schedule.prompt,
      policy: schedule.policy || 'read-only',
      playbook: schedule.playbook || undefined,
      lane: schedule.lane || undefined,
      maxTurns: schedule.maxTurns || undefined,
      projectId: targetProjectId,
      workspaceDir: resolvedWorkspace,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      trigger: 'schedule'
    };

    try {
      const activate = () => this.registry.start(request);
      const run = typeof this.admitRun === 'function'
        ? await this.admitRun(resolvedWorkspace, activate)
        : await activate();

      const nextRunAt = computeNextRun(schedule.cron, now);
      updateSchedule(
        schedule.id,
        {
          lastRunAt: now.toISOString(),
          lastRunId: run.id,
          lastStatus: 'triggered',
          lastError: null,
          nextRunAt: nextRunAt.toISOString()
        },
        this.schedulesPath
      );

      if (this.onTrigger) {
        this.onTrigger({ schedule, run, status: 'triggered' });
      }

      return { ok: true, status: 'triggered', runId: run.id };
    } catch (err) {
      const isBusy = err?.kind === 'git-workspace-busy' || err?.kind === 'git-repo-busy';
      const status = isBusy ? 'skipped-busy' : 'error';
      const nextRunAt = computeNextRun(schedule.cron, now);

      updateSchedule(
        schedule.id,
        {
          lastStatus: status,
          lastError: err.message || String(err),
          nextRunAt: nextRunAt.toISOString()
        },
        this.schedulesPath
      );

      if (this.onTrigger) {
        this.onTrigger({ schedule, error: err.message, status });
      }

      return { ok: false, status, error: err.message };
    }
  }
}
