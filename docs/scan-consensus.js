/** Agreement between fresh camera frames. No roster matching or digit correction. */
export function createScanConsensus({ required = 3, minConfidence = 70, maxGapMs = 8000 } = {}) {
  if (!Number.isInteger(required) || required < 1) throw new RangeError('required must be a positive integer');
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 100) throw new RangeError('minConfidence must be between 0 and 100');
  if (!Number.isFinite(maxGapMs) || maxGapMs <= 0) throw new RangeError('maxGapMs must be positive');
  let id = null, count = 0, lastAt = null;
  const seenFrames = new Set();
  const result = (reason, accepted = false) => ({ id, count, accepted, reason });
  function clearRun() { id = null; count = 0; lastAt = null; }
  function reset() { clearRun(); seenFrames.clear(); }
  function reject(reason) { clearRun(); return result(reason); }

  function observe(candidates, { frameId, now = Date.now() } = {}) {
    const validFrame = (typeof frameId === 'number' && Number.isFinite(frameId) && frameId >= 0)
      || (typeof frameId === 'string' && frameId.length > 0);
    if (!validFrame || !Number.isFinite(now) || now < 0) return reject('invalid-frame');
    if (lastAt !== null && now < lastAt) {
      seenFrames.add(frameId);
      return reject('stale-frame');
    }
    const expired = lastAt !== null && now - lastAt > maxGapMs;
    if (expired) clearRun();
    // Replaying an earlier frame cannot add evidence, including after a failed read.
    if (seenFrames.has(frameId)) return result('duplicate-frame');
    seenFrames.add(frameId);
    if (!Array.isArray(candidates)) return reject('invalid');
    if (!candidates.length) return reject('empty');
    if (candidates.length !== 1) return reject('ambiguous');
    const candidate = candidates[0];
    if (!candidate || typeof candidate.id !== 'string' || !/^\d{8}$/.test(candidate.id)) return reject('invalid');
    if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 100) return reject('invalid-confidence');
    if (candidate.confidence < minConfidence) return reject('low-confidence');
    const changed = id !== null && id !== candidate.id;
    count = id === candidate.id ? Math.min(required, count + 1) : 1;
    id = candidate.id;
    lastAt = now;
    const accepted = count >= required;
    return result(accepted ? 'accepted' : changed ? 'changed' : expired ? 'expired' : 'collecting', accepted);
  }
  return { observe, reset };
}
