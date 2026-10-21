// Unit conversion for the Plan form. The app stores and sends METRIC only (cm, kg); imperial is purely a
// display layer. The canonical metric value is kept in `state.canon` and only replaced when the user
// actually types a new number, so flipping Metric <-> Imperial any number of times can't accumulate
// rounding — what is shown is always derived from the canonical value, never converted back and forth.
(function (root) {
  "use strict";

  const CM_PER_INCH = 2.54;
  const KG_PER_LB = 0.45359237;

  const round = (x, digits) => {
    const f = Math.pow(10, digits);
    return Math.round((x + Number.EPSILON) * f) / f;
  };

  // metric -> display (imperial)
  function kgToLb(kg) { return round(kg / KG_PER_LB, 1); }
  function cmToFeetInches(cm) {
    const totalInches = cm / CM_PER_INCH;
    let feet = Math.floor(totalInches / 12);
    let inches = round(totalInches - feet * 12, 1);
    if (inches >= 12) { feet += 1; inches = round(inches - 12, 1); }   // 71.96 in must not show as 5'12.0"
    return { feet, inches };
  }

  // typed imperial -> canonical metric
  function lbToKg(lb) { return round(lb * KG_PER_LB, 2); }
  function feetInchesToCm(feet, inches) { return round((feet * 12 + (inches || 0)) * CM_PER_INCH, 1); }

  const api = { CM_PER_INCH, KG_PER_LB, kgToLb, cmToFeetInches, lbToKg, feetInchesToCm };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CSUnits = api;
})(typeof window !== "undefined" ? window : globalThis);
