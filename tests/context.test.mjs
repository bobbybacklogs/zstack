import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planContext, ZStack } from '../src/index.mjs';

function makeWorkspace(files) {
  const dir = mkdtempSync(join(tmpdir(), 'zstack-ctx-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

describe('context window budgeter', () => {
  it('passes small contexts through unchanged', () => {
    const dir = makeWorkspace({ 'a.ts': 'export const x = 1;\n' });
    const plan = planContext({
      files: ['a.ts'],
      playbookText: '# Playbook',
      principleTexts: { 'prove-it-works': '### Principle: prove-it-works\nVerify.' },
      principleNames: ['prove-it-works'],
      budgetTokens: 12000,
      workspaceDir: dir
    });
    assert.equal(plan.withinBudget, true);
    assert.equal(plan.aborted, false);
    assert.deepEqual(plan.trimmed, []);
    assert.deepEqual(plan.omittedPrinciples, []);
    assert.ok(plan.filesContext.includes('export const x = 1;'));
  });

  it('truncates oversized files with explicit omission markers', () => {
    const big = 'import { a } from "./x";\nexport function big() {\n' + '  console.log("line");\n'.repeat(800) + '}\n';
    const dir = makeWorkspace({ 'big.ts': big });
    const plan = planContext({
      files: ['big.ts'],
      playbookText: '# Playbook',
      principleTexts: {},
      principleNames: [],
      budgetTokens: 500,
      workspaceDir: dir
    });
    assert.equal(plan.aborted, false);
    assert.ok(plan.trimmed.some(t => t.includes('truncated file big.ts') || t.includes('omitted file big.ts')), JSON.stringify(plan.trimmed));
    assert.ok(plan.filesContext.includes('omitted lines'), 'must name the omitted range');
    assert.ok(plan.filesContext.includes('big.ts'));
  });

  it('drops trailing principles with omission notes', () => {
    const dir = makeWorkspace({});
    const names = ['prove-it-works', 'fix-root-causes', 'laziness-protocol', 'boundary-discipline', 'experience-first'];
    const texts = {};
    for (const n of names) texts[n] = `### Principle: ${n}\n` + 'rationale text '.repeat(60);
    const plan = planContext({
      files: [],
      playbookText: '# Playbook\nshort',
      principleTexts: texts,
      principleNames: names,
      budgetTokens: 120,
      workspaceDir: dir
    });
    assert.ok(plan.omittedPrinciples.length > 0, 'should drop least-relevant principles');
    assert.ok(plan.trimmed.some(t => t.includes('omitted principle')));
    assert.ok(!plan.principlesText.includes(plan.omittedPrinciples[0]) || plan.omittedPrinciples.every(p => !plan.principlesText.includes(`### Principle: ${p}`)));
  });

  it('aborts with --no-prune instead of dispatching', async () => {
    const big = 'export const x = 1;\n' + '// filler\n'.repeat(2000);
    const dir = makeWorkspace({ 'big.ts': big });
    const plan = planContext({
      files: ['big.ts'],
      playbookText: '# Playbook\n' + 'body '.repeat(200),
      principleTexts: {},
      principleNames: [],
      budgetTokens: 600,
      workspaceDir: dir,
      noPrune: true
    });
    assert.equal(plan.aborted, true);
    assert.ok(plan.abortReason.includes('--no-prune'));

    // SDK task path must throw before any model dispatch under --no-prune.
    const z = new ZStack({ workspaceDir: dir });
    await assert.rejects(
      () => z.task({ prompt: 'Add token bucket rate limiting', files: ['big.ts'], contextBudget: 600, noPrune: true, semantic: false }),
      /--no-prune/
    );
  });

  it('aborts clearly when the playbook alone exceeds the budget', () => {
    const plan = planContext({
      files: [],
      playbookText: 'x'.repeat(4000),
      principleTexts: {},
      principleNames: [],
      budgetTokens: 10,
      workspaceDir: tmpdir()
    });
    assert.equal(plan.aborted, true);
    assert.ok(plan.abortReason.includes('too small for the playbook'));
  });

  it('notes unreadable and binary files without throwing', () => {
    const dir = makeWorkspace({ 'ok.ts': 'export const y = 2;\n' });
    const plan = planContext({
      files: ['ok.ts', 'missing.ts'],
      playbookText: '# Playbook',
      principleTexts: {},
      principleNames: [],
      budgetTokens: 12000,
      workspaceDir: dir
    });
    assert.equal(plan.withinBudget, true);
    assert.ok(plan.trimmed.some(t => t.includes('missing.ts')));
  });
});
