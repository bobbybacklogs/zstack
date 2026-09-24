/**
 * Explicit document contract for playbooks and principles.
 * Small dependency-free frontmatter parser: no YAML library.
 */

function stripQuotes(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseInlineArray(value, source, key) {
  const v = value.trim();
  if (!v.startsWith('[') || !v.endsWith(']')) {
    throw new Error(`${source}: frontmatter field '${key}' must be an array like [a, b]`);
  }
  const inner = v.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(item => stripQuotes(item.trim())).filter(s => s.length > 0);
}

/**
 * Parse a markdown document's leading --- frontmatter block.
 * Known fields: id, title, applyWhen, keywords (array), requires (array), version.
 * Documents without a leading block return { data: null, fallback: true }.
 * Throws on unterminated blocks or invalid field shapes, naming the file.
 */
export function parseDoc(text, source = '<unknown>') {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  const lines = raw.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: null, body: raw, fallback: true };
  }
  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    throw new Error(`${source}: unterminated frontmatter block (missing closing ---)`);
  }
  const data = {};
  for (let i = 1; i < closing; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) {
      throw new Error(`${source}: malformed frontmatter line ${i + 1}: ${line.trim()}`);
    }
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1);
    if (key === 'keywords' || key === 'requires') {
      data[key] = parseInlineArray(value, source, key);
    } else if (key === 'id' || key === 'title' || key === 'applyWhen' || key === 'version') {
      data[key] = stripQuotes(value);
    } else {
      data[key] = stripQuotes(value);
    }
  }
  if (data.id !== undefined && typeof data.id !== 'string') {
    throw new Error(`${source}: frontmatter field 'id' must be a string`);
  }
  const body = lines.slice(closing + 1).join('\n');
  return { data, body, fallback: false };
}

/**
 * Validate parsed documents: filename/id agreement, duplicate ids across
 * sets, and field shapes. Entries look like
 * { source: 'principles/laziness-protocol.md', id, data }.
 */
export function validateDocs(docs) {
  const seen = new Map();
  const errors = [];
  for (const doc of docs || []) {
    const source = doc.source || '<unknown>';
    const base = source.split('/').pop().replace(/\.md$/, '');
    const id = doc.data?.id ?? doc.id;
    if (!id || typeof id !== 'string') {
      errors.push(`${source}: missing document id`);
      continue;
    }
    if (id !== base) {
      errors.push(`${source}: id '${id}' does not match filename '${base}'`);
    }
    if (seen.has(id)) {
      errors.push(`${source}: duplicate id '${id}' (first seen in ${seen.get(id)})`);
    } else {
      seen.set(id, source);
    }
    const keywords = doc.data?.keywords;
    if (keywords !== undefined && !Array.isArray(keywords)) {
      errors.push(`${source}: field 'keywords' must be an array`);
    }
    const requires = doc.data?.requires;
    if (requires !== undefined && !Array.isArray(requires)) {
      errors.push(`${source}: field 'requires' must be an array`);
    }
  }
  return { ok: errors.length === 0, errors };
}
