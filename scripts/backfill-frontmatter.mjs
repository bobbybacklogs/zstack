#!/usr/bin/env node
/**
 * One-shot migration: prepend the documented frontmatter block to every
 * playbook and principle so the manifest indexer never falls back to legacy
 * extraction (README "Document Contract").
 *
 * Every field is derived from data that already exists in the repo, so nothing
 * is invented:
 *   - title     <- the document's H1
 *   - applyWhen <- the existing `> **Trigger:**` / `> **Apply when:**` line
 *   - keywords  <- the classifier's own trigger regex (playbooks) or the
 *                  salient terms of applyWhen (principles)
 *   - requires  <- PLAYBOOK_TRIGGERS principles and in-body
 *                  `principles/<id>.md` cross-references
 *
 * Idempotent: files that already start with `---` are left alone.
 * Usage: node scripts/backfill-frontmatter.mjs [--check]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYBOOK_TRIGGERS } from '../src/sdk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'at',
  'by', 'from', 'as', 'is', 'are', 'be', 'been', 'it', 'its', 'that', 'this',
  'when', 'before', 'after', 'into', 'not', 'no', 'do', 'does', 'doing', 'you',
  'your', 'we', 'i', 'if', 'then', 'than', 'so', 'up', 'out', 'about', 'over',
  'same', 'own', 'more', 'most', 'also', 'just', 'only', 'very', 'can', 'will',
  'would', 'should', 'could', 'must', 'may', 'might', 'have', 'has', 'had',
  'them', 'they', 'their', 'there', 'these', 'those', 'which', 'while', 'where'
]);

/** Trigger regex source -> the literal alternation terms it matches on. */
function keywordsFromTriggerRegex(rule) {
  const source = rule.regex.source;
  const inner = source.slice(source.indexOf('(') + 1, source.lastIndexOf(')'));
  const terms = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === '|' && depth === 0) {
      terms.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  terms.push(current);

  const out = [];
  for (const raw of terms) {
    const cleaned = expandAlternation(raw).toLowerCase();
    for (const word of cleaned.split(' ')) {
      if (!word || STOPWORDS.has(word) || word.length < 2) continue;
      out.push(word);
    }
  }
  return [...new Set(out)];
}

/**
 * Normalize one alternation of a trigger regex into plain space-separated words:
 * `author(ing)?\s+a?\s*skill` -> `authoring a skill`.
 * Optional groups keep their content (the more specific reading), and whitespace
 * classes collapse to a single space so words never fuse together.
 */
function expandAlternation(raw) {
  return raw
    .replace(/\(([^()]*)\)\??/g, '$1')
    .replace(/\\s[+*?]?/g, ' ')
    .replace(/\\b/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[[\]?*+^$]/g, ' ')
    .replace(/[^a-z0-9.+-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Salient lowercase terms: the id's own words plus distinctive prose terms. */
function keywordsFromProse(id, prose) {
  const out = [];
  const keep = (word, minLength) => {
    if (!word || word.length < minLength || STOPWORDS.has(word) || !/^[a-z0-9.+-]+$/.test(word)) return;
    out.push(word);
  };

  for (const word of id.split('-')) keep(word, 2);
  for (const word of String(prose || '').toLowerCase().split(/[^a-z0-9.+-]+/)) {
    keep(word.replace(/^[.+-]+|[.+-]+$/g, ''), 5);
  }
  return [...new Set(out)].slice(0, 8);
}

function crossReferencedPrinciples(text) {
  const refs = new Set();
  for (const m of text.matchAll(/principles\/([a-z0-9-]+)\.md/g)) refs.add(m[1]);
  return [...refs];
}

function yamlArray(items) {
  return `[${items.join(', ')}]`;
}

function frontmatterFor({ id, title, applyWhen, keywords, requires }) {
  const lines = ['---', `id: ${id}`, `title: ${title}`, `applyWhen: ${applyWhen}`];
  lines.push(`keywords: ${yamlArray(keywords)}`);
  if (requires.length > 0) lines.push(`requires: ${yamlArray(requires)}`);
  lines.push('version: 1', '---', '');
  return lines.join('\n');
}

const triggerByType = new Map(PLAYBOOK_TRIGGERS.map(r => [r.type, r]));

function buildPlaybooks() {
  const dir = join(ROOT, 'playbooks');
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(file => {
    const id = file.replace(/\.md$/, '');
    const full = join(dir, file);
    const raw = readFileSync(full, 'utf8');
    if (raw.startsWith('---')) return { file, full, id, skipped: true };

    const h1 = raw.match(/^#\s+(.+)$/m);
    const title = (h1 ? h1[1] : id).replace(/^Playbook:\s*/i, '').trim();
    const trigger = raw.match(/> \*\*Trigger:\*\*\s*(.+)/i);
    const applyWhen = trigger ? trigger[1].trim() : 'General task';
    const rule = triggerByType.get(id);
    const keywords = rule ? keywordsFromTriggerRegex(rule) : keywordsFromProse(id, applyWhen);
    const requires = [...new Set([...(rule?.principles || []), ...crossReferencedPrinciples(raw)])];
    return { file, full, id, block: frontmatterFor({ id, title, applyWhen, keywords, requires }) };
  });
}

function buildPrinciples() {
  const dir = join(ROOT, 'principles');
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(file => {
    const id = file.replace(/\.md$/, '');
    const full = join(dir, file);
    const raw = readFileSync(full, 'utf8');
    if (raw.startsWith('---')) return { file, full, id, skipped: true };

    const h1 = raw.match(/^#\s+(.+)$/m);
    const title = (h1 ? h1[1] : id).trim();
    const apply = raw.match(/> \*\*Apply when:\*\*\s*(.+)/i);
    const applyWhen = apply ? apply[1].trim() : 'General engineering decisions';
    const keywords = keywordsFromProse(id, applyWhen);
    const requires = crossReferencedPrinciples(raw).filter(r => r !== id);
    return { file, full, id, block: frontmatterFor({ id, title, applyWhen, keywords, requires }) };
  });
}

let written = 0;
let skipped = 0;
for (const entry of [...buildPlaybooks(), ...buildPrinciples()]) {
  if (entry.skipped) {
    skipped++;
    continue;
  }
  if (CHECK_ONLY) {
    console.log(`would add frontmatter: ${entry.file}`);
    written++;
    continue;
  }
  writeFileSync(entry.full, entry.block + readFileSync(entry.full, 'utf8'), 'utf8');
  written++;
}

console.log(`${CHECK_ONLY ? 'pending' : 'backfilled'}=${written} already-had-frontmatter=${skipped}`);
