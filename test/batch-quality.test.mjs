import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../dist/app.js';
import { DomainError } from '../dist/domain/errors.js';

const tenantId = 'tenant_test';
const projectId = 'project_test';
let runCounter = 0;

function makeApp(aliquotCount = 3) {
  const app = new SampleChainApplication();
  const sealed = app.sampling.createSealedSample({
    tenantId,
    projectId,
    collectorId: 'collector_01',
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt: '2026-10-06T08:00:00.000Z',
    location: { latitude: 31.23, longitude: 121.47, siteCode: 'SITE-SH-01' },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: 'device_01',
    clientSequence: 1,
    containerBarcode: 'CNT-TEST-001',
    sealCode: 'SEAL-001',
    totalVolumeMl: 100,
  });
  const transfer = app.custody.handOver({
    tenantId,
    projectId,
    containerId: sealed.container.id,
    fromHolderId: 'collector_01',
    toHolderId: 'courier_01',
    fromLocation: 'SITE-SH-01',
    toLocation: 'LAB-SH-A',
    handedOverAt: '2026-10-06T08:30:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: 'handover-001',
  });
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT' });
  app.receiving.receive({ tenantId, projectId, containerId: sealed.container.id, receivedBy: 'lab_receiver_01', receivedAt: '2026-10-06T10:15:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: 'receive-001' });
  const items = Array.from({ length: aliquotCount }, (_, index) => ({ barcode: `ALQ-${String(index + 1).padStart(3, '0')}`, volumeMl: 10, unit: 'ML' }));
  const aliquots = app.aliquots.createMany({ tenantId, projectId, parentContainerId: sealed.container.id, protocolVersion: 'water-v3', createdBy: 'analyst_01', operationId: 'aliquot-001', items });
  return { app, aliquots };
}

function createBatch(app, aliquots, requiredControls = [{ kind: 'BLANK', minimumCount: 1 }]) {
  const batch = app.batches.create({ tenantId, projectId, protocolVersion: 'water-v3', instrumentType: 'ICP-MS', requiredControls, createdBy: 'analyst_01' });
  for (const aliquot of aliquots) app.batches.addAliquot(batch.id, aliquot.id);
  return batch;
}

function startBatch(app, aliquots, requiredControls) {
  const batch = createBatch(app, aliquots, requiredControls);
  app.batches.markReady(batch.id);
  app.batches.start(batch.id, '2026-10-06T11:00:00.000Z');
  return batch;
}

function registerRun(app, batch) {
  runCounter += 1;
  return app.results.registerRun({ tenantId, projectId, batchId: batch.id, externalRunId: `RUN-${String(runCounter).padStart(3, '0')}`, rawFileHash: `raw-${runCounter}`, instrumentSoftwareVersion: 'instrument-7.2', startedAt: '2026-10-06T11:10:00.000Z' });
}

let hashCounter = 0;
function ingest(app, batch, run, overrides = {}) {
  hashCounter += 1;
  return app.results.ingestRevision({
    tenantId,
    projectId,
    batchId: batch.id,
    runId: run.id,
    analyte: 'lead',
    value: 0.12,
    unit: 'mg/L',
    detectionLimit: 0.01,
    qualityFlags: [],
    instrumentSoftwareVersion: 'instrument-7.2',
    contentHash: `hash-${hashCounter}`,
    ...overrides,
  });
}

function approve(app, batch, result, ruleVersion = 'quality-v2') {
  return app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: result.id, decision: 'APPROVED', reason: 'within limits', ruleVersion, reviewerId: 'reviewer_01' });
}

function expectDomainError(fn, code) {
  assert.throws(fn, (error) => error instanceof DomainError && error.code === code, `expected DomainError ${code}`);
}

test('partial failure: failed start leaves the batch fully in READY and can be retried', () => {
  const { app, aliquots } = makeApp();
  const batch = createBatch(app, aliquots);
  app.batches.markReady(batch.id);
  // Simulate a concurrent release: one member is no longer allocated.
  app.store.aliquots.get(aliquots[1].id).status = 'AVAILABLE';
  const versionBefore = batch.version;
  expectDomainError(() => app.batches.start(batch.id, '2026-10-06T11:00:00.000Z'), 'batch.member_not_allocated');
  assert.equal(batch.status, 'READY');
  assert.equal(batch.startedAt, undefined);
  assert.equal(batch.frozenAt, undefined);
  assert.equal(batch.frozenMemberAliquotIds, undefined);
  assert.equal(batch.version, versionBefore);
  // Repair and retry: the same check is idempotently retryable.
  app.store.aliquots.get(aliquots[1].id).status = 'ALLOCATED';
  app.batches.start(batch.id, '2026-10-06T11:00:00.000Z');
  assert.equal(batch.status, 'RUNNING');
  assert.deepEqual(batch.frozenMemberAliquotIds, batch.memberAliquotIds);
});

test('partial failure: invalid control attachment and failed-run ingestion change nothing', () => {
  const { app, aliquots } = makeApp();
  const batchA = startBatch(app, [aliquots[0]]);
  const batchB = startBatch(app, [aliquots[1]]);
  const runA = registerRun(app, batchA);
  const runB = registerRun(app, batchB);
  const foreignControl = ingest(app, batchB, runB, { controlKind: 'BLANK', analyte: 'blank-check' });
  const sampleResult = ingest(app, batchA, runA, { aliquotId: aliquots[0].id });

  expectDomainError(() => app.batches.attachControlResult(batchA.id, foreignControl.id), 'scope.forbidden');
  expectDomainError(() => app.batches.attachControlResult(batchA.id, sampleResult.id), 'batch.not_a_control');
  expectDomainError(() => app.batches.attachControlResult(batchA.id, 'result_99999999'), 'batch.control_result_not_found');
  assert.deepEqual(batchA.controlResultIds, []);

  // A failed run must not accept results, and the failed ingest creates nothing.
  app.results.completeRun(runA.id, '2026-10-06T12:00:00.000Z', 'FAILED');
  const resultsBefore = app.store.results.size;
  expectDomainError(() => ingest(app, batchA, runA, { controlKind: 'BLANK', analyte: 'blank-check' }), 'result.run_failed');
  assert.equal(app.store.results.size, resultsBefore);

  // External run ids cannot be replayed against a different batch.
  expectDomainError(
    () => app.results.registerRun({ tenantId, projectId, batchId: batchB.id, externalRunId: runA.externalRunId, rawFileHash: runA.rawFileHash, instrumentSoftwareVersion: 'instrument-7.2', startedAt: '2026-10-06T11:10:00.000Z' }),
    'result.run_conflict',
  );
});

test('partial failure: results cannot be ingested into a batch that is not executing', () => {
  const { app, aliquots } = makeApp();
  const batch = createBatch(app, [aliquots[0]]);
  const run = { id: 'run_fake' };
  expectDomainError(() => ingest(app, batch, run, { aliquotId: aliquots[0].id }), 'result.run_not_found');
});

test('concurrent members: same aliquot added concurrently is membership exactly once', async () => {
  const { app, aliquots } = makeApp();
  const batch = createBatch(app, []);
  const target = aliquots[0];
  await Promise.all([
    app.store.transaction(async () => { app.batches.addAliquot(batch.id, target.id); }),
    app.store.transaction(async () => { app.batches.addAliquot(batch.id, target.id); }),
  ]);
  assert.deepEqual(batch.memberAliquotIds, [target.id]);
  assert.equal(app.store.aliquots.get(target.id).status, 'ALLOCATED');
});

test('concurrent members: one aliquot cannot join two batches at once', async () => {
  const { app, aliquots } = makeApp();
  const batchA = createBatch(app, []);
  const batchB = createBatch(app, []);
  const target = aliquots[0];
  const outcomes = await Promise.allSettled([
    app.store.transaction(async () => { app.batches.addAliquot(batchA.id, target.id); }),
    app.store.transaction(async () => { app.batches.addAliquot(batchB.id, target.id); }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  const holders = [batchA, batchB].filter((batch) => batch.memberAliquotIds.includes(target.id));
  assert.equal(holders.length, 1);
  assert.equal(app.store.aliquots.get(target.id).status, 'ALLOCATED');
});

test('concurrent members: add racing with start is either frozen in or rejected, never lost or duplicated', async () => {
  const { app, aliquots } = makeApp();
  const batch = createBatch(app, [aliquots[0]]);
  app.batches.markReady(batch.id);
  const latecomer = aliquots[1];
  const [addOutcome] = await Promise.allSettled([
    app.store.transaction(async () => { app.batches.addAliquot(batch.id, latecomer.id); }),
    app.store.transaction(async () => { app.batches.start(batch.id, '2026-10-06T11:00:00.000Z'); }),
  ]);
  assert.equal(batch.status, 'RUNNING');
  if (addOutcome.status === 'fulfilled') {
    assert.deepEqual(new Set(batch.frozenMemberAliquotIds), new Set([aliquots[0].id, latecomer.id]));
  } else {
    assert.equal(addOutcome.reason.code, 'batch.members_locked');
    assert.deepEqual(batch.frozenMemberAliquotIds, [aliquots[0].id]);
  }
  assert.deepEqual(batch.memberAliquotIds, batch.frozenMemberAliquotIds);
  assert.equal(new Set(batch.memberAliquotIds).size, batch.memberAliquotIds.length);
});

test('frozen rules: mutating members or control requirements after start cannot bypass the gate', () => {
  const { app, aliquots } = makeApp();
  const batch = startBatch(app, [aliquots[0]], [{ kind: 'BLANK', minimumCount: 1 }]);
  const run = registerRun(app, batch);
  const sampleResult = ingest(app, batch, run, { aliquotId: aliquots[0].id });
  approve(app, batch, sampleResult);

  // Tamper with the live rule list after the run started: approval must still
  // evaluate the frozen requirements.
  batch.requiredControls.length = 0;
  expectDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.control_missing');

  // Tamper with the live member list: results are still validated against the
  // frozen member set, and non-member results are rejected at ingestion.
  batch.memberAliquotIds.push(aliquots[1].id);
  expectDomainError(() => ingest(app, batch, run, { aliquotId: aliquots[1].id }), 'result.aliquot_not_member');
});

test('out-of-order QC: approval only passes once every control and decision is in place', () => {
  const { app, aliquots } = makeApp();
  const batch = startBatch(app, [aliquots[0]], [{ kind: 'BLANK', minimumCount: 1 }, { kind: 'CALIBRATION', minimumCount: 1 }]);
  const run = registerRun(app, batch);
  const sampleResult = ingest(app, batch, run, { aliquotId: aliquots[0].id });

  // No decisions at all yet.
  expectDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.result_unapproved');
  approve(app, batch, sampleResult);
  // Sample approved, but both controls are missing.
  expectDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.control_missing');

  // Decide on the blank BEFORE attaching it: order of upload vs review must not matter.
  const blank = ingest(app, batch, run, { controlKind: 'BLANK', analyte: 'blank-check' });
  approve(app, batch, blank);
  app.batches.attachControlResult(batch.id, blank.id);
  expectDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.control_missing');

  const calibration = ingest(app, batch, run, { controlKind: 'CALIBRATION', analyte: 'cal-check' });
  app.batches.attachControlResult(batch.id, calibration.id);
  // Attached but not yet reviewed.
  expectDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.result_unapproved');
  approve(app, batch, calibration);

  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});

test('control gate: superseded or detached controls never satisfy the requirement', () => {
  const { app, aliquots } = makeApp();
  const batch = startBatch(app, [aliquots[0]], [{ kind: 'BLANK', minimumCount: 1 }]);
  const run = registerRun(app, batch);
  const sampleResult = ingest(app, batch, run, { aliquotId: aliquots[0].id });
  const blankV1 = ingest(app, batch, run, { controlKind: 'BLANK', analyte: 'blank-check' });
  app.batches.attachControlResult(batch.id, blankV1.id);
  approve(app, batch, sampleResult);
  approve(app, batch, blankV1);

  // A corrected blank revision supersedes the attached one: the stale id must
  // stop counting until the new revision is attached and reviewed.
  const blankV2 = ingest(app, batch, run, { controlKind: 'BLANK', analyte: 'blank-check' });
  assert.equal(blankV1.status, 'SUPERSEDED');
  approve(app, batch, blankV2);
  // Reviewed but not attached: the gate still counts nothing.
  expectDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.control_missing');
  expectDomainError(() => app.batches.attachControlResult(batch.id, blankV1.id), 'batch.control_not_current');

  app.batches.attachControlResult(batch.id, blankV2.id);
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});

test('failed QC upload retry: attach is idempotent and failed runs contribute nothing', () => {
  const { app, aliquots } = makeApp();
  const batch = startBatch(app, [aliquots[0]], [{ kind: 'BLANK', minimumCount: 1 }]);
  const failedRun = registerRun(app, batch);
  const blankV1 = ingest(app, batch, failedRun, { controlKind: 'BLANK', analyte: 'blank-check' });
  app.batches.attachControlResult(batch.id, blankV1.id);
  // The upload fails midway; the analyst retries the batch with a new run.
  app.results.completeRun(failedRun.id, '2026-10-06T12:00:00.000Z', 'FAILED');
  const retryRun = registerRun(app, batch);
  const sampleResult = ingest(app, batch, retryRun, { aliquotId: aliquots[0].id });
  const blankV2 = ingest(app, batch, retryRun, { controlKind: 'BLANK', analyte: 'blank-check' });

  // Retrying the attachment of the same result is a no-op, never a duplicate.
  app.batches.attachControlResult(batch.id, blankV2.id);
  app.batches.attachControlResult(batch.id, blankV2.id);
  assert.deepEqual(batch.controlResultIds.filter((id) => id === blankV2.id), [blankV2.id]);

  approve(app, batch, sampleResult);
  approve(app, batch, blankV2);
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});

test('retest after rejection: stale passes are invalidated and a fresh round is required', () => {
  const { app, aliquots } = makeApp();
  const batch = startBatch(app, [aliquots[0]], [{ kind: 'BLANK', minimumCount: 1 }]);
  const run = registerRun(app, batch);
  const sampleV1 = ingest(app, batch, run, { aliquotId: aliquots[0].id });
  const blankV1 = ingest(app, batch, run, { controlKind: 'BLANK', analyte: 'blank-check' });
  app.batches.attachControlResult(batch.id, blankV1.id);
  approve(app, batch, sampleV1);
  approve(app, batch, blankV1);

  // Reviewer demands a retest of the sample result.
  app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: sampleV1.id, decision: 'RETEST_REQUIRED', reason: 'peak shape abnormal', ruleVersion: 'quality-v2', reviewerId: 'reviewer_02' });
  assert.equal(batch.status, 'RUNNING');
  assert.deepEqual(batch.controlResultIds, []);

  // The retested result still carries both an approval and a retest mark: the
  // old pass must not be reusable.
  const retestRun = registerRun(app, batch);
  expectDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.result_rejected');

  // Fresh revisions for the retest, fresh control, fresh reviews.
  const sampleV2 = ingest(app, batch, retestRun, { aliquotId: aliquots[0].id });
  const blankV2 = ingest(app, batch, retestRun, { controlKind: 'BLANK', analyte: 'blank-check' });
  app.batches.attachControlResult(batch.id, blankV2.id);
  approve(app, batch, sampleV2);
  approve(app, batch, blankV2);
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
  assert.equal(sampleV1.status, 'SUPERSEDED');
});

test('rejected batch: terminal, cleared of control passes, and closed to further decisions', () => {
  const { app, aliquots } = makeApp();
  const batch = startBatch(app, [aliquots[0]], [{ kind: 'BLANK', minimumCount: 1 }]);
  const run = registerRun(app, batch);
  const sampleResult = ingest(app, batch, run, { aliquotId: aliquots[0].id });
  const blank = ingest(app, batch, run, { controlKind: 'BLANK', analyte: 'blank-check' });
  app.batches.attachControlResult(batch.id, blank.id);
  approve(app, batch, blank);

  app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: sampleResult.id, decision: 'REJECTED', reason: 'contamination confirmed', ruleVersion: 'quality-v2', reviewerId: 'reviewer_02' });
  assert.equal(batch.status, 'REJECTED');
  assert.deepEqual(batch.controlResultIds, []);

  expectDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.batch_not_reviewable');
  expectDomainError(
    () => app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: sampleResult.id, decision: 'APPROVED', reason: 'second thoughts', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01' }),
    'quality.batch_not_reviewable',
  );
});

test('duplicate approval: idempotent, and an approved batch is closed to mutation', () => {
  const { app, aliquots } = makeApp();
  const batch = startBatch(app, [aliquots[0]], [{ kind: 'BLANK', minimumCount: 1 }]);
  const run = registerRun(app, batch);
  const sampleResult = ingest(app, batch, run, { aliquotId: aliquots[0].id });
  const blank = ingest(app, batch, run, { controlKind: 'BLANK', analyte: 'blank-check' });
  app.batches.attachControlResult(batch.id, blank.id);
  approve(app, batch, sampleResult);
  approve(app, batch, blank);

  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
  const approvedAt = batch.approvedAt;
  const version = batch.version;
  const auditCount = app.store.audit.length;
  const outboxCount = app.store.outbox.length;

  // Repeated approval changes nothing.
  app.quality.approveBatch(batch.id, 'reviewer_02');
  assert.equal(batch.status, 'APPROVED');
  assert.equal(batch.approvedAt, approvedAt);
  assert.equal(batch.version, version);
  assert.equal(app.store.audit.length, auditCount);
  assert.equal(app.store.outbox.length, outboxCount);

  // And nothing may be attached, decided or ingested after approval.
  expectDomainError(() => app.batches.attachControlResult(batch.id, blank.id), 'batch.controls_locked');
  expectDomainError(
    () => app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: sampleResult.id, decision: 'REJECTED', reason: 'late doubt', ruleVersion: 'quality-v2', reviewerId: 'reviewer_02' }),
    'quality.batch_not_reviewable',
  );
  expectDomainError(() => ingest(app, batch, run, { aliquotId: aliquots[0].id }), 'result.batch_not_accepting');
});

test('idempotent review: the same quality decision can be safely retried', () => {
  const { app, aliquots } = makeApp();
  const batch = startBatch(app, [aliquots[0]], [{ kind: 'BLANK', minimumCount: 1 }]);
  const run = registerRun(app, batch);
  const sampleResult = ingest(app, batch, run, { aliquotId: aliquots[0].id });
  const input = { tenantId, projectId, batchId: batch.id, resultId: sampleResult.id, decision: 'APPROVED', reason: 'within limits', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01' };
  const first = app.quality.decide(input);
  const auditCount = app.store.audit.length;
  const second = app.quality.decide(input);
  assert.equal(second.id, first.id);
  assert.equal(app.store.quality.size, 1);
  assert.equal(app.store.audit.length, auditCount);
});
