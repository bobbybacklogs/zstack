import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_STATE_FILE = join(__dirname, '..', 'verification', 'upstream-sync.json');
const UPSTREAM_REPO = 'cursor/plugins';
const UPSTREAM_PATH = 'pstack';

/**
 * Read the current upstream tracking state.
 */
export function getSyncState(statePath = DEFAULT_STATE_FILE) {
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      // Fallback below
    }
  }
  return {
    repo: UPSTREAM_REPO,
    path: UPSTREAM_PATH,
    url: `https://github.com/${UPSTREAM_REPO}/tree/main/${UPSTREAM_PATH}`,
    lastSyncedCommit: null,
    lastSyncedDate: null,
    lastSyncedMessage: null
  };
}

/**
 * Record a new upstream sync checkpoint.
 */
export function saveSyncState(commit, statePath = DEFAULT_STATE_FILE) {
  const current = getSyncState(statePath);
  const updated = {
    ...current,
    lastSyncedCommit: commit.sha,
    lastSyncedDate: commit.commit?.author?.date || new Date().toISOString(),
    lastSyncedMessage: commit.commit?.message?.split('\n')[0] || '',
    lastCheckTimestamp: new Date().toISOString()
  };
  writeFileSync(statePath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  return updated;
}

/**
 * Check GitHub repository for new commits targeting pstack.
 * Runs on demand as a single API call (zero persistent daemon overhead).
 */
export async function checkUpstream(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_FILE;
  const state = getSyncState(statePath);
  const token = options.token || process.env.GITHUB_TOKEN;

  const headers = {
    'User-Agent': 'zstack-upstream-checker',
    'Accept': 'application/vnd.github.v3+json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = `https://api.github.com/repos/${UPSTREAM_REPO}/commits?path=${UPSTREAM_PATH}&per_page=10`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`GitHub API error (HTTP ${res.status}): ${errorText}`);
  }

  const commits = await res.json();
  if (!Array.isArray(commits) || commits.length === 0) {
    return {
      hasUpdates: false,
      message: 'No commits found for upstream pstack',
      state
    };
  }

  const latestCommit = commits[0];
  const lastSynced = state.lastSyncedCommit;

  // If already at latest commit
  if (lastSynced && latestCommit.sha.startsWith(lastSynced) || (lastSynced && latestCommit.sha === lastSynced)) {
    return {
      hasUpdates: false,
      currentSha: lastSynced,
      latestSha: latestCommit.sha,
      latestDate: latestCommit.commit?.author?.date,
      latestMessage: latestCommit.commit?.message?.split('\n')[0],
      state
    };
  }

  // Find all commits since last synced
  const newCommits = [];
  for (const c of commits) {
    if (lastSynced && (c.sha === lastSynced || c.sha.startsWith(lastSynced))) {
      break;
    }
    newCommits.push({
      sha: c.sha.slice(0, 10),
      fullSha: c.sha,
      author: c.commit?.author?.name || 'unknown',
      date: c.commit?.author?.date,
      message: c.commit?.message?.split('\n')[0] || ''
    });
  }

  // Fetch file changes for the latest commit
  let changedFiles = [];
  try {
    const commitDetailRes = await fetch(
      `https://api.github.com/repos/${UPSTREAM_REPO}/commits/${latestCommit.sha}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (commitDetailRes.ok) {
      const detail = await commitDetailRes.json();
      changedFiles = (detail.files || [])
        .filter(f => f.filename.startsWith('pstack/'))
        .map(f => ({
          file: f.filename.replace(/^pstack\//, ''),
          status: f.status,
          additions: f.additions,
          deletions: f.deletions
        }));
    }
  } catch {
    // Non-fatal if detailed file inspection fails
  }

  return {
    hasUpdates: true,
    lastSyncedSha: lastSynced ? lastSynced.slice(0, 10) : 'none',
    latestSha: latestCommit.sha.slice(0, 10),
    latestFullCommit: latestCommit,
    commitCount: newCommits.length,
    newCommits,
    changedFiles,
    state
  };
}

/**
 * Interactively prompt user to review and record upstream changes.
 */
export async function handleUpdateCommand(options = {}) {
  console.log('\nChecking upstream pstack (https://github.com/cursor/plugins/tree/main/pstack)...');

  let result;
  try {
    result = await checkUpstream(options);
  } catch (err) {
    console.error(`[!] Failed to check upstream: ${err.message}`);
    process.exit(1);
  }

  if (!result.hasUpdates) {
    console.log(`[✓] zstack is up to date with upstream pstack.`);
    console.log(`    Synced commit: ${result.latestSha?.slice(0, 10) || result.state?.lastSyncedCommit?.slice(0, 10)}`);
    console.log(`    Date:          ${result.latestDate || result.state?.lastSyncedDate}`);
    console.log(`    Latest commit: ${result.latestMessage || result.state?.lastSyncedMessage}\n`);
    return { updated: false, result };
  }

  console.log(`\n[!] Upstream changes detected (${result.commitCount} new commit${result.commitCount > 1 ? 's' : ''}):`);
  console.log('--------------------------------------------------------------------------------');
  for (const c of result.newCommits) {
    console.log(`  ${c.sha}  [${c.date?.slice(0, 10)}]  ${c.author.padEnd(14)} ${c.message}`);
  }
  console.log('--------------------------------------------------------------------------------');

  if (result.changedFiles.length > 0) {
    console.log('\nModified files in upstream pstack:');
    for (const f of result.changedFiles) {
      const stats = `(+${f.additions}/-${f.deletions})`;
      console.log(`  [${f.status.padEnd(8)}] ${f.file.padEnd(35)} ${stats}`);
    }
  }

  const shouldApply = options.apply || options.yes;
  let confirmUpdate = false;

  if (shouldApply) {
    confirmUpdate = true;
  } else if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('\nRecord and sync this upstream checkpoint? (y/N): ');
    rl.close();
    confirmUpdate = answer.trim().toLowerCase() === 'y';
  } else {
    console.log('\nRun with --apply (or -y) to record this checkpoint and update sync state.');
  }

  if (confirmUpdate) {
    saveSyncState(result.latestFullCommit, options.statePath);
    console.log(`\n[✓] Upstream sync state updated to commit ${result.latestSha}.`);
    console.log(`    Verification tracking saved to verification/upstream-sync.json.`);
    return { updated: true, result };
  } else {
    console.log('\nUpdate aborted by user. Upstream tracking state remains unchanged.');
    return { updated: false, result };
  }
}
