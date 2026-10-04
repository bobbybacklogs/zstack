import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseDoc, packageSkill, formatSkillDoc, ZStack } from '../src/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

function runCli(args, cwd = ROOT) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [join(ROOT, 'bin', 'zstack.mjs'), ...args], {
      cwd,
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => res({ code, stdout, stderr }));
  });
}

describe('zstack skill packaging', () => {
  let tempBase;

  before(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'zstack-skill-test-'));
  });

  after(() => {
    if (tempBase && existsSync(tempBase)) {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });

  it('golden output for playbooks/feature.md packages correctly', () => {
    const targetDir = join(tempBase, 'feature-golden');
    const result = packageSkill({
      playbookId: 'feature',
      outDir: targetDir,
      rootDir: ROOT
    });

    assert.equal(result.ok, true);
    assert.equal(result.skill, 'feature');
    assert.equal(result.dryRun, false);
    assert.deepEqual(result.files, [join(targetDir, 'SKILL.md')]);
    assert.deepEqual(result.principles, [
      'foundational-thinking',
      'boundary-discipline',
      'sequence-verifiable-units',
      'type-system-discipline',
      'prove-it-works',
      'build-the-lever',
      'laziness-protocol'
    ]);

    const writtenPath = join(targetDir, 'SKILL.md');
    assert.ok(existsSync(writtenPath), 'SKILL.md must exist');
    const content = readFileSync(writtenPath, 'utf8');

    // 1. Frontmatter matches existing skill file shape
    const parsed = parseDoc(content, 'SKILL.md');
    assert.equal(parsed.fallback, false, 'Frontmatter must not fallback');
    assert.equal(parsed.data.name, 'feature');
    assert.equal(parsed.data.description, 'Implementing new user-facing functionality, API routes, or a new subsystem.');

    // 2. Body keeps playbook steps in order
    const step1Idx = content.indexOf('## Step 1: Clarify the Consumer & Maintainer Value');
    const step2Idx = content.indexOf('## Step 2: Define Data Shapes & Boundaries');
    const step3Idx = content.indexOf('## Step 3: Build the Verification Harness First');
    const step4Idx = content.indexOf('## Step 4: Implement in Small Verifiable Units');
    const step5Idx = content.indexOf('## Step 5: Verify Against the Real Artifact');
    const step6Idx = content.indexOf('## Step 6: Review & Final Report');

    assert.ok(step1Idx > 0, 'Must include Step 1');
    assert.ok(step2Idx > step1Idx, 'Step 2 must follow Step 1');
    assert.ok(step3Idx > step2Idx, 'Step 3 must follow Step 2');
    assert.ok(step4Idx > step3Idx, 'Step 4 must follow Step 3');
    assert.ok(step5Idx > step4Idx, 'Step 5 must follow Step 4');
    assert.ok(step6Idx > step5Idx, 'Step 6 must follow Step 5');

    // 3. Required principles section inlines each principle in order as referenced section
    const reqSectionIdx = content.indexOf('## Required Principles');
    assert.ok(reqSectionIdx > step6Idx, 'Required principles must be placed after playbook steps');

    const p1Idx = content.indexOf('### Foundational Thinking (`principles/foundational-thinking.md`)');
    const p2Idx = content.indexOf('### Boundary Discipline (`principles/boundary-discipline.md`)');
    const p3Idx = content.indexOf('### Sequence Work into Verifiable Units (`principles/sequence-verifiable-units.md`)');
    const p4Idx = content.indexOf('### Type System Discipline (`principles/type-system-discipline.md`)');
    const p5Idx = content.indexOf('### Prove It Works (`principles/prove-it-works.md`)');
    const p6Idx = content.indexOf('### Build the Lever (`principles/build-the-lever.md`)');
    const p7Idx = content.indexOf('### Laziness Protocol (`principles/laziness-protocol.md`)');

    assert.ok(p1Idx > reqSectionIdx);
    assert.ok(p2Idx > p1Idx);
    assert.ok(p3Idx > p2Idx);
    assert.ok(p4Idx > p3Idx);
    assert.ok(p5Idx > p4Idx);
    assert.ok(p6Idx > p5Idx);
    assert.ok(p7Idx > p6Idx);

    // Each principle inlines core rules
    assert.ok(content.includes('#### Core Rules'));

    // 4. Verification section names npm run verify
    const verifyIdx = content.indexOf('## Verification');
    assert.ok(verifyIdx > p7Idx, 'Verification must follow principles');
    assert.ok(content.includes('npm run verify'), 'Must name npm run verify');

    // 5. Compare with dry-run output
    const dryResult = packageSkill({
      playbookId: 'feature',
      dryRun: true,
      rootDir: ROOT
    });
    assert.equal(dryResult.dryRun, true);
    assert.deepEqual(dryResult.files, []);
    assert.equal(dryResult.content, content);
  });

  it('dry-run writes nothing to disk', () => {
    const targetDir = join(tempBase, 'dry-run-check');
    const result = packageSkill({
      playbookId: 'feature',
      outDir: targetDir,
      dryRun: true,
      rootDir: ROOT
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.files, []);
    assert.ok(!existsSync(join(targetDir, 'SKILL.md')), 'Must not write file on dry-run');
  });

  it('refuses when required principle does not exist', () => {
    const fakeRoot = join(tempBase, 'missing-principle-fixture');
    mkdirSync(join(fakeRoot, 'playbooks'), { recursive: true });
    mkdirSync(join(fakeRoot, 'principles'), { recursive: true });

    // Playbook requiring a non-existent principle
    const playbookDoc = `---
id: broken-req
title: Broken Requirements
applyWhen: Testing missing principle
requires: [ghost-principle]
---
# Playbook: Broken Requirements

## Step 1: Attempt
`;
    writeFileSync(join(fakeRoot, 'playbooks', 'broken-req.md'), playbookDoc, 'utf8');

    const targetDir = join(tempBase, 'out-missing-principle');
    assert.throws(
      () => packageSkill({ playbookId: 'broken-req', outDir: targetDir, rootDir: fakeRoot }),
      /ghost-principle/
    );

    // Verify no files were created
    assert.ok(!existsSync(join(targetDir, 'SKILL.md')));
  });

  it('refuses when playbook is missing frontmatter, listing offending file', () => {
    const fakeRoot = join(tempBase, 'no-frontmatter-fixture');
    mkdirSync(join(fakeRoot, 'playbooks'), { recursive: true });

    const rawMarkdown = `# Playbook Without Frontmatter\n\n## Step 1: Nothing\n`;
    writeFileSync(join(fakeRoot, 'playbooks', 'no-fm.md'), rawMarkdown, 'utf8');

    const targetDir = join(tempBase, 'out-no-fm');
    assert.throws(
      () => packageSkill({ playbookId: 'no-fm', outDir: targetDir, rootDir: fakeRoot }),
      /playbooks\/no-fm\.md/
    );

    // Refuse rather than emitting degraded skill
    assert.ok(!existsSync(join(targetDir, 'SKILL.md')));
  });

  it('refuses when a required principle is missing frontmatter', () => {
    const fakeRoot = join(tempBase, 'no-fm-principle-fixture');
    mkdirSync(join(fakeRoot, 'playbooks'), { recursive: true });
    mkdirSync(join(fakeRoot, 'principles'), { recursive: true });

    writeFileSync(join(fakeRoot, 'playbooks', 'req-no-fm.md'), `---
id: req-no-fm
title: Req No FM
applyWhen: Test
requires: [plain-principle]
---
# Playbook
`, 'utf8');

    writeFileSync(join(fakeRoot, 'principles', 'plain-principle.md'), `# Plain Principle\nNo FM\n`, 'utf8');

    const targetDir = join(tempBase, 'out-principle-no-fm');
    assert.throws(
      () => packageSkill({ playbookId: 'req-no-fm', outDir: targetDir, rootDir: fakeRoot }),
      /principles\/plain-principle\.md/
    );

    assert.ok(!existsSync(join(targetDir, 'SKILL.md')));
  });

  it('refuses to overwrite existing target unless --force', () => {
    const targetDir = join(tempBase, 'overwrite-test');
    mkdirSync(targetDir, { recursive: true });
    const targetFile = join(targetDir, 'SKILL.md');
    writeFileSync(targetFile, 'existing content', 'utf8');

    // Without force: refuses
    assert.throws(
      () => packageSkill({ playbookId: 'feature', outDir: targetDir, rootDir: ROOT, force: false }),
      /already exists/
    );
    assert.equal(readFileSync(targetFile, 'utf8'), 'existing content');

    // With force: succeeds and overwrites
    const result = packageSkill({ playbookId: 'feature', outDir: targetDir, rootDir: ROOT, force: true });
    assert.equal(result.ok, true);
    assert.notEqual(readFileSync(targetFile, 'utf8'), 'existing content');
  });

  it('refuses duplicate skill name across skills/ and .agents/skills/ unless --force', () => {
    const fakeRoot = join(tempBase, 'dup-check-fixture');
    mkdirSync(join(fakeRoot, 'playbooks'), { recursive: true });
    mkdirSync(join(fakeRoot, 'principles'), { recursive: true });
    mkdirSync(join(fakeRoot, '.agents', 'skills', 'verify-zstack'), { recursive: true });
    mkdirSync(join(fakeRoot, 'skills'), { recursive: true });

    // Existing skill in .agents/skills/verify-zstack/SKILL.md
    writeFileSync(join(fakeRoot, '.agents', 'skills', 'verify-zstack', 'SKILL.md'), '---', 'utf8');

    // Playbook with same id
    writeFileSync(join(fakeRoot, 'playbooks', 'verify-zstack.md'), `---
id: verify-zstack
title: Verify zstack
applyWhen: Verification
requires: []
---
# Playbook
`, 'utf8');

    // Target is skills/verify-zstack
    const targetDir = join(fakeRoot, 'skills', 'verify-zstack');
    assert.throws(
      () => packageSkill({ playbookId: 'verify-zstack', outDir: targetDir, rootDir: fakeRoot, force: false }),
      /already exists in.*\.agents\/skills\/verify-zstack\/SKILL\.md/
    );

    // With force: allowed
    const forced = packageSkill({ playbookId: 'verify-zstack', outDir: targetDir, rootDir: fakeRoot, force: true });
    assert.equal(forced.ok, true);
    assert.ok(existsSync(join(targetDir, 'SKILL.md')));
  });

  it('generated frontmatter parses cleanly through src/manifest.mjs', () => {
    const doc = formatSkillDoc({
      playbook: {
        id: 'test-skill',
        title: 'Test Skill',
        applyWhen: 'Running integration tests.',
        body: '# Test Skill\n\n## Step 1: Run\n'
      },
      principles: []
    });

    const parsed = parseDoc(doc, 'SKILL.md');
    assert.equal(parsed.fallback, false);
    assert.equal(parsed.data.name, 'test-skill');
    assert.equal(parsed.data.description, 'Running integration tests.');
  });

  it('no partial files exist after a validation failure', () => {
    const fakeRoot = join(tempBase, 'validation-fail-fixture');
    mkdirSync(join(fakeRoot, 'playbooks'), { recursive: true });

    // Invalid applyWhen causing empty description in skill frontmatter
    writeFileSync(join(fakeRoot, 'playbooks', 'bad-fm.md'), `---
id: bad-fm
title: Bad
keywords: []
---
# Body
`, 'utf8');

    const targetDir = join(tempBase, 'no-partial-files');
    assert.throws(
      () => packageSkill({ playbookId: 'bad-fm', outDir: targetDir, rootDir: fakeRoot }),
      /applyWhen/
    );

    if (existsSync(targetDir)) {
      const files = readdirSync(targetDir);
      assert.deepEqual(files, [], 'Target dir must have zero files after validation failure');
    }
  });

  it('handles relative and absolute --out paths', () => {
    // 1. Absolute path
    const absDir = join(tempBase, 'abs-path-skill');
    const absRes = packageSkill({ playbookId: 'feature', outDir: absDir, rootDir: ROOT });
    assert.equal(absRes.ok, true);
    assert.ok(existsSync(join(absDir, 'SKILL.md')));

    // 2. Relative path
    const relName = 'rel-temp-skill-' + Date.now();
    const relDir = join(tempBase, relName);
    const cwdBefore = process.cwd();
    try {
      process.chdir(tempBase);
      const relRes = packageSkill({ playbookId: 'feature', outDir: relName, rootDir: ROOT });
      assert.equal(relRes.ok, true);
      assert.ok(existsSync(join(relDir, 'SKILL.md')));
    } finally {
      process.chdir(cwdBefore);
    }
  });

  it('ZStack SDK method packageSkill delegates cleanly', () => {
    const z = new ZStack({ rootDir: ROOT });
    const targetDir = join(tempBase, 'sdk-method-test');
    const res = z.packageSkill({ playbookId: 'feature', outDir: targetDir });
    assert.equal(res.ok, true);
    assert.ok(existsSync(join(targetDir, 'SKILL.md')));
  });

  it('CLI zstack skill works end-to-end', async () => {
    // 1. Missing playbook argument gives usage error
    const noArg = await runCli(['skill']);
    assert.equal(noArg.code, 2);
    assert.ok(noArg.stderr.includes('requires a playbook id'));

    // 2. --dry-run prints to stdout
    const dry = await runCli(['skill', 'feature', '--dry-run']);
    assert.equal(dry.code, 0);
    assert.ok(dry.stdout.includes('name: feature'));
    assert.ok(dry.stdout.includes('## Step 1: Clarify the Consumer & Maintainer Value'));
    assert.ok(dry.stdout.includes('## Required Principles'));
    assert.ok(dry.stdout.includes('npm run verify'));

    // 3. Write to directory
    const cliOut = join(tempBase, 'cli-test');
    const writeRun = await runCli(['skill', 'feature', '--out', cliOut]);
    assert.equal(writeRun.code, 0);
    assert.ok(writeRun.stdout.includes('Packaged skill [feature]'));
    assert.ok(existsSync(join(cliOut, 'SKILL.md')));

    // 4. Overwrite without force fails with code 1
    const noForce = await runCli(['skill', 'feature', '--out', cliOut]);
    assert.equal(noForce.code, 1);
    assert.ok(noForce.stderr.includes('already exists'));

    // 5. Overwrite with --force succeeds
    const forceRun = await runCli(['skill', 'feature', '--out', cliOut, '--force']);
    assert.equal(forceRun.code, 0);
    assert.ok(forceRun.stdout.includes('Packaged skill [feature]'));

    // 6. --json emits structured JSON
    const jsonOut = join(tempBase, 'cli-json-test');
    const jsonRun = await runCli(['skill', 'feature', '--out', jsonOut, '--json']);
    assert.equal(jsonRun.code, 0);
    const parsedJson = JSON.parse(jsonRun.stdout);
    assert.equal(parsedJson.ok, true);
    assert.equal(parsedJson.skill, 'feature');
    assert.equal(parsedJson.principles.length, 7);
  });
});
