import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routineLaneOptions } from '../web/render.js';
import { LANES, normalizeLane } from '../src/index.mjs';

/**
 * The only automated coverage of the browser client's lane wiring.
 *
 * The client as a whole is a documented gap: no suite drives its DOM. This file
 * does not change that. It covers one pure function, because the lane choices a
 * dialog offers decide what a saved routine runs on, and the failure mode is
 * silent — a missing sentinel rewrites the lane on save, and a missing entry
 * resets a routine that was pinned to a lane the list no longer names.
 */

/** What `GET /api/config` serves, in the shape the dialog consumes. */
function servedLanes() {
  return Object.entries(LANES).map(([id, lane]) => ({ id, name: lane.name, prefix: lane.prefix, description: lane.description }));
}

describe('routine dialog lane options', () => {
  it('leads with the stored-default sentinel', () => {
    // The empty value is not `auto`: auto resolves to Zen or Hitch and never to
    // HuggingFace, while a stored lane may be any of the five. Submitting `auto`
    // where the sentinel belongs overrides the stored lane on every save.
    for (const lanes of [[], servedLanes()]) {
      const options = routineLaneOptions(lanes, '');
      assert.equal(options[0].id, '', 'the sentinel must be first so it is the default selection');
      assert.match(options[0].label, /stored default/);
    }
  });

  it('offers every served lane, with the server naming them', () => {
    const options = routineLaneOptions(servedLanes(), '');
    const ids = options.map((o) => o.id);
    for (const id of Object.keys(LANES)) {
      assert.ok(ids.includes(id), `lane ${id} must be offered`);
    }
    const hf = options.find((o) => o.id === 'hf');
    assert.equal(hf.label, 'HuggingFace (hf)', 'a lane too large a name to guess must come from the server');
  });

  it('falls back to its own list when the config never loaded', () => {
    const ids = routineLaneOptions([], '').map((o) => o.id);
    for (const id of Object.keys(LANES)) {
      assert.ok(ids.includes(id), `the fallback must still offer ${id} without a server list`);
    }
    assert.equal(ids[0], '');
  });

  it('keeps a stored lane the current list does not name', () => {
    // Saving a routine must not clear a lane the operator chose, even when the
    // server's list has moved on.
    const options = routineLaneOptions(servedLanes(), 'retired-lane');
    const kept = options.find((o) => o.id === 'retired-lane');
    assert.ok(kept, 'an unrecognized stored lane must keep its own entry');
    assert.match(kept.label, /not in the current lane list/);
    // A lane that IS named must not be duplicated.
    const hfCount = routineLaneOptions(servedLanes(), 'hf').filter((o) => o.id === 'hf').length;
    assert.equal(hfCount, 1);
  });

  it('offers only lane ids the validator accepts', () => {
    const ids = routineLaneOptions(servedLanes(), '').map((o) => o.id).filter(Boolean);
    for (const id of ids) {
      assert.equal(normalizeLane(id), id, `${id} must already be canonical, since it is sent verbatim`);
      assert.ok(LANES[id], `${id} must be a real lane`);
    }
  });

  it('ignores a malformed lanes payload rather than rendering nothing', () => {
    for (const bad of [null, undefined, 'hf', 42, {}]) {
      const options = routineLaneOptions(bad, '');
      assert.ok(options.length > 1, `lanes=${JSON.stringify(bad)} must fall back to the built-in list`);
      assert.ok(options.some((o) => o.id === 'hf'));
    }
  });
});
