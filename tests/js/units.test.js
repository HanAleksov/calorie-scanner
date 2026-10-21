// Run: node --test tests/js
const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../../frontend/units.js");

test("kg <-> lb: 65 kg shows as 143.3 lb and typing 143.3 gives back 65 (typed value, not a re-conversion)", () => {
  assert.equal(U.kgToLb(65), 143.3);
  assert.equal(U.lbToKg(143.3), 65);
  assert.equal(U.kgToLb(30), 66.1);          // the lower bound is a normal weight
  assert.equal(U.lbToKg(66.1), 29.98);
});

test("the unit mix-up: 65 read as pounds is ~29.48 kg, which the server rejects as < 30", () => {
  assert.equal(U.lbToKg(65), 29.48);
});

test("cm <-> ft/in", () => {
  assert.deepEqual(U.cmToFeetInches(178), { feet: 5, inches: 10.1 });
  assert.equal(U.feetInchesToCm(5, 10.1), 178.1);
  assert.ok(Math.abs(U.feetInchesToCm(5, 10.1) - 178) <= 1);
  assert.equal(U.feetInchesToCm(6, 0), 182.9);
  assert.deepEqual(U.cmToFeetInches(170), { feet: 5, inches: 6.9 });
});

test("inches never display as 12 (5'12.0\" must roll over to 6'0\")", () => {
  for (let cm = 150; cm <= 220; cm += 0.1) {
    const { inches } = U.cmToFeetInches(Math.round(cm * 10) / 10);
    assert.ok(inches < 12, `${cm} cm -> ${inches} in`);
  }
  assert.deepEqual(U.cmToFeetInches(182.8), { feet: 6, inches: 0 });
});

test("175 feet converts to an impossible height that the server's 100-250 cm range rejects", () => {
  assert.equal(U.feetInchesToCm(175, 0), 5334);
  assert.ok(U.feetInchesToCm(175, 0) > 250);
});

test("display is a pure function of the canonical metric value: repeated flips can't drift", () => {
  const canon = { heightCm: 178, weightKg: 65 };
  const shownImperial = () => [U.cmToFeetInches(canon.heightCm), U.kgToLb(canon.weightKg)];
  const first = JSON.stringify(shownImperial());
  for (let i = 0; i < 100; i++) assert.equal(JSON.stringify(shownImperial()), first);
  assert.deepEqual(canon, { heightCm: 178, weightKg: 65 });
});

test("canonAfterEdit: only the edited value is recomputed, the other is returned exactly as it was", () => {
  const canon = { heightCm: 178, weightKg: 80 };
  // imperial, user types inches: weight stays 80 (not 176.4 lb -> 80.01 kg)
  assert.deepEqual(U.canonAfterEdit(canon, "imperial", "height", { heightMain: 5, heightIn: 11, weight: 176.4 }),
    { heightCm: 180.3, weightKg: 80 });
  // imperial, user types pounds: height stays 178 (not 5 ft 10.1 in -> 178.1 cm)
  assert.deepEqual(U.canonAfterEdit(canon, "imperial", "weight", { heightMain: 5, heightIn: 10.1, weight: 180 }),
    { heightCm: 178, weightKg: 81.65 });
  // metric: typed value is taken as is
  assert.deepEqual(U.canonAfterEdit(canon, "metric", "height", { heightMain: 181, heightIn: null, weight: 80 }),
    { heightCm: 181, weightKg: 80 });
  assert.deepEqual(U.canonAfterEdit(canon, "metric", "weight", { heightMain: 178, heightIn: null, weight: 79.5 }),
    { heightCm: 178, weightKg: 79.5 });
  // an emptied field becomes null; an unknown field changes nothing; the input object is not mutated
  assert.deepEqual(U.canonAfterEdit(canon, "imperial", "weight", { heightMain: 5, heightIn: 10.1, weight: null }),
    { heightCm: 178, weightKg: null });
  assert.deepEqual(U.canonAfterEdit(canon, "metric", "other", {}), { heightCm: 178, weightKg: 80 });
  assert.deepEqual(canon, { heightCm: 178, weightKg: 80 });
});

test("canonAfterEdit: inches left empty count as 0, empty feet clears the height", () => {
  const canon = { heightCm: 178, weightKg: 80 };
  assert.equal(U.canonAfterEdit(canon, "imperial", "height", { heightMain: 6, heightIn: null, weight: 176.4 }).heightCm, 182.9);
  assert.equal(U.canonAfterEdit(canon, "imperial", "height", { heightMain: null, heightIn: 10, weight: 176.4 }).heightCm, null);
});
