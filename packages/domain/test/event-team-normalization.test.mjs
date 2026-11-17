import test from "node:test";
import assert from "node:assert/strict";

import { normalizeFieldViewEventTeam } from "../dist/normalization/event-team.js";
import { archimedes2026EventOprs } from "../dist/fixtures/archimedes-sf13m1.js";

test("event-team normalization associates event OPR values by unchanged TBA team key", () => {
  const input = {
    event_key: "2026arc",
    team_key: "frc7407",
    tba_event_oprs: archimedes2026EventOprs,
  };

  const result = normalizeFieldViewEventTeam(input);

  assert.deepEqual(result, {
    event_key: "2026arc",
    team_key: "frc7407",
    opr: archimedes2026EventOprs.oprs.frc7407,
    dpr: archimedes2026EventOprs.dprs.frc7407,
    ccwm: archimedes2026EventOprs.ccwms.frc7407,
  });
  assert.strictEqual(result.opr, archimedes2026EventOprs.oprs.frc7407);
  assert.strictEqual(input.tba_event_oprs, archimedes2026EventOprs);
});

test("event-team normalization preserves explicit null status and omits absent values", () => {
  const result = normalizeFieldViewEventTeam({
    event_key: "2026arc",
    team_key: "frc7407",
    tba_status: null,
  });

  assert.deepEqual(result, {
    event_key: "2026arc",
    team_key: "frc7407",
    tba_status: null,
  });
  assert.equal("opr" in result, false);
  assert.equal("dpr" in result, false);
  assert.equal("ccwm" in result, false);
});

test("event-team normalization leaves an absent status absent", () => {
  const result = normalizeFieldViewEventTeam({
    event_key: "2026arc",
    team_key: "frc7407",
  });

  assert.equal("tba_status" in result, false);
});


test("event-team domain object survives JSON transport round-trip", () => {
  const eventTeam = normalizeFieldViewEventTeam({
    event_key: "2026arc",
    team_key: "frc7407",
    tba_status: null,
    tba_event_oprs: archimedes2026EventOprs,
  });

  const received = JSON.parse(JSON.stringify(eventTeam));
  assert.deepEqual(received, eventTeam);
  assert.equal(received.tba_status, null);
  assert.equal(received.opr, archimedes2026EventOprs.oprs.frc7407);
  assert.equal(received.dpr, archimedes2026EventOprs.dprs.frc7407);
  assert.equal(received.ccwm, archimedes2026EventOprs.ccwms.frc7407);
});
