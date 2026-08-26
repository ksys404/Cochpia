export function gateResult(status, reason, evidence = []) {
  return { status, reason, evidence };
}
export function assessFullCanonical1MArtifact(report, evidence = []) {
  const complete = report && Number(report.documentCount) >= 1_000_000
    && Number(report.assertionCount) >= 1_000_000
    && report.leanIndex !== true
    && report.fastSeed !== true
    && report.pgvector === true
    && report.hnswRebuiltAfterSeed === true
    && typeof report.runDate === 'string'
    && report.runDate.trim()
    && typeof report.reproduction === 'string'
    && report.reproduction.trim()
    && report.provenance
    && typeof report.provenance === 'object'
    && !Array.isArray(report.provenance)
    && Object.keys(report.provenance).length > 0;
  return complete
    ? gateResult('passed', 'full canonical 1M pgvector/HNSW artifact validated', evidence)
    : gateResult('failed', 'artifact is missing full canonical assertion/version volume, provenance, reproduction, or is marked lean/fast-seed');
}

export function assessEvidenceEnvelope(report, requiredKeys, evidence = []) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return gateResult('failed', 'evidence envelope must be an object');
  const missing = requiredKeys.filter(key => report.gates?.[key] !== true);
  return missing.length
    ? gateResult('failed', `evidence gates missing: ${missing.join(',')}`)
    : gateResult('passed', 'required evidence gates are explicitly true', evidence);
}

export function isAlphaGateReady(gates) {
  return Boolean(gates) && Object.values(gates).length > 0 && Object.values(gates).every(gate => gate?.status === 'passed');
}
