/* global describe, test, expect */
// Every skill script must follow the reading rules it teaches (_shared/HEAVY-READS.md):
// sort only by _id, one API call at a time, one condition per field. A finding kept on purpose
// carries `// heavy-read-ok: <reason>` on its line or the line above.
const fs = require('fs');
const path = require('path');
const { heavyReadFindings } = require('../.claude/skills/_shared/heavy-read-check');

const SKILLS = path.join(__dirname, '..', '.claude', 'skills');

function scripts() {
  const out = [];
  for (const skill of fs.readdirSync(SKILLS)) {
    const dir = path.join(SKILLS, skill, 'scripts');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(c|m)?js$/.test(name)) continue;
      const full = path.join(dir, name);
      out.push({ rel: path.relative(SKILLS, full), text: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

describe('skill scripts follow HEAVY-READS', () => {
  test('no script sorts on a field without an index, reads in parallel or puts two operators on one field', () => {
    const blockers = heavyReadFindings(scripts())
      .filter((f) => f.level === 'blocker')
      .map((f) => `${f.rule} ${f.file}:${f.line}${f.field ? ` (${f.field})` : ''}`);
    expect(blockers).toEqual([]);
  });

  test('an accepted finding needs a reason', () => {
    const plain = { rel: 'x/scripts/a.js', text: "await fetch('/v2/stage?sort=-updatedAt');" };
    const ok = { rel: 'x/scripts/b.js', text: "// heavy-read-ok: stages are a short configuration list\nawait fetch('/v2/stage?sort=-updatedAt');" };
    const empty = { rel: 'x/scripts/c.js', text: "// heavy-read-ok:\nawait fetch('/v2/stage?sort=-updatedAt');" };
    expect(heavyReadFindings([plain]).map((f) => f.rule)).toEqual(['heavyListSort']);
    expect(heavyReadFindings([ok])).toEqual([]);
    expect(heavyReadFindings([empty]).map((f) => f.rule)).toEqual(['heavyListSort']);
  });
});
