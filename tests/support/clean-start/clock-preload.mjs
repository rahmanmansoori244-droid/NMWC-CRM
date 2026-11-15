// The Node half of the clean-start flow test's pinned clock (FAKE_UTC_OFFSET,
// whole seconds): Date.now(), new Date() and Date() answer real + offset. A Date
// made from a value is unchanged. Loaded only through NODE_OPTIONS=--import by
// tests/integration/clean-start-flow.test.ts; a no-op when the variable is unset or 0.
// It installs once per process: a second evaluation (the same file reached by
// another path, e.g. the test's copy of the repository) changes nothing.
const MARK = Symbol.for('nmwc.cleanStartFlowClock');
const off = Number(process.env.FAKE_UTC_OFFSET || 0) * 1000;
if (!globalThis[MARK] && Number.isFinite(off) && off !== 0) {
  globalThis[MARK] = true;
  const Real = globalThis.Date;
  function FakeDate(...a) {
    if (!new.target) return new Real(Real.now() + off).toString();
    return a.length ? new Real(...a) : new Real(Real.now() + off);
  }
  FakeDate.prototype = Real.prototype;
  FakeDate.now = () => Real.now() + off;
  FakeDate.parse = Real.parse;
  FakeDate.UTC = Real.UTC;
  globalThis.Date = FakeDate;
}
