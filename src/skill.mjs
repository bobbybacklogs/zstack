/**
 * Skill packaging for zstack.
 * Packages a playbook and its required principles into a standalone SKILL.md.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname, basename } from 'node:path';
import { parseDoc } from './manifest.mjs';

export const DEFAULT_VERIFY_COMMAND = 'npm run verify';

/**
 * Format a SKILL.md document from a parsed playbook and its required principles.
 * Keeps playbook steps in order, inlines each principle as a referenced section,
 * and appends a verification section naming the repository's verify command.
 */
export function formatSkillDoc({ playbook, principles = [], verifyCommand = DEFAULT_VERIFY_COMMAND }) {
  const frontmatter = [
    '---',
    `name: ${playbook.id}`,
    `description: ${playbook.applyWhen}`,
    '---'
  ].join('\n');

  const playbookBody = String(playbook.body || '').trim().replace(/\r\n/g, '\n');

  const principleSections = principles.map(p => {
    // Strip leading `# <Title>` heading from the principle body
    let rawBody = String(p.body || '').trim().replace(/\r\n/g, '\n');
    const h1Match = rawBody.match(/^#\s+[^\n]*\n?/);
    if (h1Match) {
      rawBody = rawBody.slice(h1Match[0].length).trim();
    }
    // Bump any `## ` headings to `#### ` so they nest cleanly under the principle h3
    const nestedBody = rawBody.replace(/^##\s+/gm, '#### ');
    return `### ${p.title} (\`principles/${p.id}.md\`)\n\n${nestedBody}`;
  });

  const principlesBlock = principleSections.length > 0
    ? `\n\n---\n\n## Required Principles\n\n${principleSections.join('\n\n')}`
    : '';

  const verificationBlock = [
    '---',
    '',
    '## Verification',
    '',
    "Run this repository's verify command to prove changes against the behavior contract:",
    '',
    '```bash',
    verifyCommand,
    '```'
  ].join('\n');

  return `${frontmatter}\n\n${playbookBody}${principlesBlock}\n\n${verificationBlock}\n`;
}

/**
 * Check for duplicate skill names across standard skill locations:
 * `skills/<name>/SKILL.md` and `.agents/skills/<name>/SKILL.md`.
 */
export function checkCrossLocationCollision({ skillName, targetFile, rootDir, force = false }) {
  if (force) return;
  const standardLocations = [
    join(rootDir, 'skills', skillName, 'SKILL.md'),
    join(rootDir, '.agents', 'skills', skillName, 'SKILL.md')
  ];
  const targetResolved = resolve(targetFile);
  for (const loc of standardLocations) {
    const locResolved = resolve(loc);
    if (locResolved !== targetResolved && existsSync(locResolved)) {
      const displayLoc = loc.replace(/\\/g, '/');
      throw new Error(
        `Skill '${skillName}' already exists in ${displayLoc}. Refusing duplicate skill name across skills/ and .agents/skills/ (use --force to override).`
      );
    }
  }
}

/**
 * Package a playbook and its required principles into a SKILL.md file.
 *
 * @param {object} options
 * @param {string} options.playbookId Playbook identifier (e.g. 'feature')
 * @param {string} [options.outDir] Target output directory (relative or absolute)
 * @param {boolean} [options.dryRun=false] When true, emits content without writing
 * @param {boolean} [options.force=false] When true, overwrites existing files and ignores collisions
 * @param {string} [options.rootDir] Repository root directory (defaults to cwd)
 * @param {string} [options.verifyCommand] Verify command (defaults to 'npm run verify')
 * @returns {object} { ok, skill, targetFile, files, principles, content, dryRun }
 */
export function packageSkill({
  playbookId,
  outDir = null,
  dryRun = false,
  force = false,
  rootDir = process.cwd(),
  verifyCommand = DEFAULT_VERIFY_COMMAND
}) {
  if (!playbookId || typeof playbookId !== 'string') {
    throw new Error('packageSkill requires a valid playbookId');
  }

  const cleanPlaybookId = playbookId.replace(/\.md$/, '').trim();
  const playbookPath = join(rootDir, 'playbooks', `${cleanPlaybookId}.md`);
  const playbookRel = `playbooks/${cleanPlaybookId}.md`;

  if (!existsSync(playbookPath)) {
    throw new Error(`Playbook not found: ${cleanPlaybookId} (searched ${playbookRel})`);
  }

  const rawPlaybook = readFileSync(playbookPath, 'utf8');
  const parsedPlaybook = parseDoc(rawPlaybook, playbookRel);

  // Refuse if playbook is missing frontmatter; list the offending file
  if (parsedPlaybook.fallback || !parsedPlaybook.data) {
    throw new Error(`Playbook is missing frontmatter: ${playbookRel}`);
  }

  const { data: pData, body: pBody } = parsedPlaybook;
  const playbookTitle = pData.title || cleanPlaybookId;
  const playbookApplyWhen = pData.applyWhen;

  if (!playbookApplyWhen) {
    throw new Error(`Playbook is missing 'applyWhen' in frontmatter: ${playbookRel}`);
  }

  const requiredIds = Array.isArray(pData.requires) ? pData.requires : [];
  const resolvedPrinciples = [];

  for (const reqId of requiredIds) {
    const principleRel = `principles/${reqId}.md`;
    const principlePath = join(rootDir, 'principles', `${reqId}.md`);

    if (!existsSync(principlePath)) {
      throw new Error(`Required principle not found: '${reqId}' (referenced by ${playbookRel})`);
    }

    const rawPrinciple = readFileSync(principlePath, 'utf8');
    const parsedPrinciple = parseDoc(rawPrinciple, principleRel);

    if (parsedPrinciple.fallback || !parsedPrinciple.data) {
      throw new Error(`Principle is missing frontmatter: ${principleRel}`);
    }

    resolvedPrinciples.push({
      id: reqId,
      title: parsedPrinciple.data.title || reqId,
      applyWhen: parsedPrinciple.data.applyWhen || '',
      body: parsedPrinciple.body
    });
  }

  // Format generated SKILL.md content
  const renderedContent = formatSkillDoc({
    playbook: {
      id: cleanPlaybookId,
      title: playbookTitle,
      applyWhen: playbookApplyWhen,
      requires: requiredIds,
      body: pBody
    },
    principles: resolvedPrinciples,
    verifyCommand
  });

  // Re-parse through existing manifest parser before any disk write
  const recheck = parseDoc(renderedContent, 'SKILL.md');
  if (recheck.fallback || !recheck.data || !recheck.data.name || !recheck.data.description) {
    throw new Error('Generated SKILL.md frontmatter failed validation with manifest parser');
  }

  // Determine target directory and file path
  let targetDir;
  if (outDir) {
    const resolvedDir = isAbsolute(outDir) ? outDir : resolve(process.cwd(), outDir);
    // If outDir explicitly ended in SKILL.md, use its dirname
    if (basename(resolvedDir).toLowerCase() === 'skill.md') {
      targetDir = dirname(resolvedDir);
    } else {
      targetDir = resolvedDir;
    }
  } else {
    targetDir = resolve(rootDir, 'skills', cleanPlaybookId);
  }

  const targetFile = join(targetDir, 'SKILL.md');

  // Collision checks
  checkCrossLocationCollision({
    skillName: cleanPlaybookId,
    targetFile,
    rootDir,
    force
  });

  if (existsSync(targetFile) && !force) {
    const displayTarget = targetFile.replace(/\\/g, '/');
    throw new Error(`Target file already exists: ${displayTarget}. Use --force to overwrite.`);
  }

  // Write atomically (temp file then rename)
  if (!dryRun) {
    mkdirSync(targetDir, { recursive: true });
    const tempPath = join(targetDir, `.SKILL.md.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      writeFileSync(tempPath, renderedContent, 'utf8');
      renameSync(tempPath, targetFile);
    } catch (err) {
      try {
        if (existsSync(tempPath)) rmSync(tempPath, { force: true });
      } catch {}
      throw err;
    }
  }

  return {
    ok: true,
    skill: cleanPlaybookId,
    targetFile,
    files: dryRun ? [] : [targetFile],
    principles: requiredIds,
    content: renderedContent,
    dryRun
  };
}
