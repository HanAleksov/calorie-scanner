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
