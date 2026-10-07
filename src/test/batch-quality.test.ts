import test from 'node:test';
import assert from 'node:assert/strict';
import { SampleChainApplication } from '../app.js';
import { DomainError } from '../domain/errors.js';
import type { Aliquot, AnalysisBatch, ControlRequirement, InstrumentRun, QualityDecisionType, ResultRevision } from '../domain/types.js';

const tenantId = 'tenant_test';
const projectId = 'project_test';
const RULE = 'quality-v2';
const STARTED_AT = '2026-10-06T11:00:00.000Z';

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function assertDomainError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    if (!(error instanceof DomainError)) assert.fail(`expected DomainError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

/** Drives one container through sampling, custody and receiving, then splits it into aliquots. */
function bootstrap(app: SampleChainApplication, aliquotCount: number): Aliquot[] {
  const suffix = unique('boot');
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
    clientSequence: sequence,
    containerBarcode: `CNT-${suffix}`,
    sealCode: `SEAL-${suffix}`,
    totalVolumeMl: 100,
  });
  const transfer = app.custody.handOver({ tenantId, projectId, containerId: sealed.container.id, fromHolderId: 'collector_01', toHolderId: 'courier_01', fromLocation: 'SITE-SH-01', toLocation: 'LAB-SH-A', handedOverAt: '2026-10-06T08:30:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', clientOperationId: `handover-${suffix}` });
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT' });
  app.receiving.receive({ tenantId, projectId, containerId: sealed.container.id, receivedBy: 'lab_receiver_01', receivedAt: '2026-10-06T10:15:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: `receive-${suffix}` });
  return app.aliquots.createMany({
    tenantId,
    projectId,
    parentContainerId: sealed.container.id,
    protocolVersion: 'water-v3',
    createdBy: 'analyst_01',
    operationId: `aliquot-${suffix}`,
    items: Array.from({ length: aliquotCount }, (_, index) => ({ barcode: `ALQ-${suffix}-${index}`, volumeMl: 10, unit: 'ML' as const })),
  });
}

function createBatch(app: SampleChainApplication, memberIds: string[], requiredControls: ControlRequirement[] = [{ kind: 'BLANK', minimumCount: 1 }]): AnalysisBatch {
  const batch = app.batches.create({ tenantId, projectId, protocolVersion: 'water-v3', instrumentType: 'ICP-MS', ruleVersion: RULE, requiredControls, createdBy: 'analyst_01' });
  for (const aliquotId of memberIds) app.batches.addAliquot(batch.id, aliquotId);
  return batch;
}

function startBatch(app: SampleChainApplication, batch: AnalysisBatch): void {
  app.batches.markReady(batch.id);
  app.batches.start(batch.id, STARTED_AT);
}

function completedRun(app: SampleChainApplication, batch: AnalysisBatch): InstrumentRun {
  const externalRunId = unique('RUN');
  const run = app.results.registerRun({ tenantId, projectId, batchId: batch.id, externalRunId, rawFileHash: `raw-${externalRunId}`, instrumentSoftwareVersion: 'instrument-7.2', startedAt: '2026-10-06T11:10:00.000Z' });
  app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'COMPLETED');
  return run;
}

function ingestSample(app: SampleChainApplication, batch: AnalysisBatch, run: InstrumentRun, aliquotId: string, contentHash: string, analyte = 'lead'): ResultRevision {
  return app.results.ingestRevision({ tenantId, projectId, batchId: batch.id, runId: run.id, aliquotId, analyte, value: 0.1, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'instrument-7.2', contentHash });
}

function ingestControl(app: SampleChainApplication, batch: AnalysisBatch, run: InstrumentRun, kind: ControlRequirement['kind'], contentHash: string, analyte = 'lead'): ResultRevision {
  return app.results.ingestRevision({ tenantId, projectId, batchId: batch.id, runId: run.id, controlKind: kind, analyte, value: 0.001, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'instrument-7.2', contentHash });
}

function decide(app: SampleChainApplication, batch: AnalysisBatch, resultId: string, decision: QualityDecisionType, reason: string) {
  return app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId, decision, reason, ruleVersion: RULE, reviewerId: 'reviewer_01' });
}

function storedBatch(app: SampleChainApplication, batchId: string): AnalysisBatch {
  const batch = app.store.batches.get(batchId);
  assert.ok(batch, 'batch should exist');
  return batch;
}

test('部分失败: failed start validates before mutating and can be retried', () => {
  const app = new SampleChainApplication();
  const [member] = bootstrap(app, 1);
  const batch = createBatch(app, [member!.id]);
  app.batches.markReady(batch.id);
  // A concurrent process released the member allocation before start validated it.
  const storedAliquot = app.store.aliquots.get(member!.id)!;
  storedAliquot.status = 'AVAILABLE';
  const versionBefore = batch.version;
  assertDomainError(() => app.batches.start(batch.id, STARTED_AT), 'batch.member_not_allocated');
  assert.equal(batch.status, 'READY');
  assert.equal(batch.startedAt, undefined);
  assert.equal(batch.frozenAt, undefined);
  assert.equal(batch.version, versionBefore);
  assert.equal(app.store.outbox.filter((message) => message.topic === 'batch.started').length, 0);
  // The same start succeeds once the member is allocated again.
  storedAliquot.status = 'ALLOCATED';
  app.batches.start(batch.id, STARTED_AT);
  assert.equal(batch.status, 'RUNNING');
  assert.equal(batch.startedAt, STARTED_AT);
});

test('部分失败: rolled-back member adds retry without duplicating members', async () => {
  const app = new SampleChainApplication();
  const [first, second] = bootstrap(app, 2);
  const batch = createBatch(app, []);
  await assert.rejects(
    app.store.transaction(() => {
      app.batches.addAliquot(batch.id, first!.id);
      app.batches.addAliquot(batch.id, second!.id);
      throw new Error('upload failed mid-batch');
    }),
    /upload failed mid-batch/,
  );
  // The transaction rolled both member adds and the allocation back.
  assert.deepEqual(storedBatch(app, batch.id).memberAliquotIds, []);
  assert.equal(app.store.aliquots.get(first!.id)!.status, 'AVAILABLE');
  await app.store.transaction(() => {
    app.batches.addAliquot(batch.id, first!.id);
    app.batches.addAliquot(batch.id, second!.id);
  });
  assert.deepEqual(storedBatch(app, batch.id).memberAliquotIds, [first!.id, second!.id]);
  // Re-adding an existing member is an idempotent no-op.
  app.batches.addAliquot(batch.id, first!.id);
  assert.deepEqual(storedBatch(app, batch.id).memberAliquotIds, [first!.id, second!.id]);
});

test('部分失败: interrupted control upload blocks the gate until retried', () => {
  const app = new SampleChainApplication();
  const [member] = bootstrap(app, 1);
  const batch = createBatch(app, [member!.id]);
  startBatch(app, batch);
  const run = completedRun(app, batch);
  const blankHash = unique('hash');
  const sample = ingestSample(app, batch, run, member!.id, unique('hash'));
  const blank = ingestControl(app, batch, run, 'BLANK', blankHash);
  decide(app, batch, sample.id, 'APPROVED', 'within limits');
  decide(app, batch, blank.id, 'APPROVED', 'blank clean');
  // The upload "failed" before the control was attached, so the gate must hold.
  assertDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.control_missing');
  // Retrying the upload replays the ingest and attaches the same control.
  const reingested = app.results.ingestRevision({ tenantId, projectId, batchId: batch.id, runId: run.id, controlKind: 'BLANK', analyte: 'lead', value: 0.001, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'instrument-7.2', contentHash: blankHash });
  assert.equal(reingested.id, blank.id);
  app.batches.attachControlResult(batch.id, blank.id);
  const versionAfterAttach = batch.version;
  app.batches.attachControlResult(batch.id, blank.id);
  assert.equal(batch.version, versionAfterAttach);
  assert.deepEqual(batch.controlResultIds, [blank.id]);
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});

test('成员并发变更: member added before start is frozen into the run', async () => {
  const app = new SampleChainApplication();
  const [first, second] = bootstrap(app, 2);
  const batch = createBatch(app, [first!.id]);
  // Analyst A retries the preparation while analyst B adds a normal sample.
  await Promise.all([
    app.store.transaction(() => {
      app.batches.addAliquot(batch.id, second!.id);
    }),
    app.store.transaction(() => {
      app.batches.markReady(batch.id);
      app.batches.start(batch.id, STARTED_AT);
    }),
  ]);
  const stored = storedBatch(app, batch.id);
  assert.equal(stored.status, 'RUNNING');
  assert.deepEqual(stored.memberAliquotIds, [first!.id, second!.id]);
  assert.equal(app.store.aliquots.get(second!.id)!.status, 'ALLOCATED');
});

test('成员并发变更: member added after start is rejected and rolled back', async () => {
  const app = new SampleChainApplication();
  const [first, second] = bootstrap(app, 2);
  const batch = createBatch(app, [first!.id]);
  const startTxn = app.store.transaction(() => {
    app.batches.markReady(batch.id);
    app.batches.start(batch.id, STARTED_AT);
  });
  const addTxn = app.store.transaction(() => {
    app.batches.addAliquot(batch.id, second!.id);
  });
  await assert.rejects(addTxn, (error: unknown) => error instanceof DomainError && error.code === 'batch.members_locked');
  await startTxn;
  const stored = storedBatch(app, batch.id);
  assert.equal(stored.status, 'RUNNING');
  assert.deepEqual(stored.memberAliquotIds, [first!.id]);
  assert.equal(app.store.aliquots.get(second!.id)!.status, 'AVAILABLE');
  // Replaying an add for an existing member is still a safe no-op.
  app.batches.addAliquot(batch.id, first!.id);
  assert.deepEqual(storedBatch(app, batch.id).memberAliquotIds, [first!.id]);
});

test('质控乱序: controls, results and decisions land in any order', () => {
  const app = new SampleChainApplication();
  const [member] = bootstrap(app, 1);
  const batch = createBatch(app, [member!.id], [{ kind: 'BLANK', minimumCount: 1 }, { kind: 'CALIBRATION', minimumCount: 1 }]);
  startBatch(app, batch);
  const run = completedRun(app, batch);
  // Calibration arrives before the blank; the sample result arrives last.
  const calibration = ingestControl(app, batch, run, 'CALIBRATION', unique('hash'));
  const blank = ingestControl(app, batch, run, 'BLANK', unique('hash'));
  const sample = ingestSample(app, batch, run, member!.id, unique('hash'));
  // Attach and review in an interleaved order.
  app.batches.attachControlResult(batch.id, blank.id);
  decide(app, batch, sample.id, 'APPROVED', 'within limits');
  app.batches.attachControlResult(batch.id, calibration.id);
  decide(app, batch, calibration.id, 'APPROVED', 'calibration passed');
  decide(app, batch, blank.id, 'APPROVED', 'blank clean');
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});

test('质控乱序: superseded control keeps neither its seat nor its approval', () => {
  const app = new SampleChainApplication();
  const [member] = bootstrap(app, 1);
  const batch = createBatch(app, [member!.id]);
  startBatch(app, batch);
  const run = completedRun(app, batch);
  const sample = ingestSample(app, batch, run, member!.id, unique('hash'));
  const blankV1 = ingestControl(app, batch, run, 'BLANK', unique('hash'));
  app.batches.attachControlResult(batch.id, blankV1.id);
  decide(app, batch, sample.id, 'APPROVED', 'within limits');
  decide(app, batch, blankV1.id, 'APPROVED', 'blank clean');
  // A corrected blank supersedes the attached one before approval.
  const blankV2 = ingestControl(app, batch, run, 'BLANK', unique('hash'));
  assert.equal(app.store.results.get(blankV1.id)!.status, 'SUPERSEDED');
  // The stale revision can no longer be attached or reviewed.
  assertDomainError(() => app.batches.attachControlResult(batch.id, blankV1.id), 'batch.control_not_current');
  assertDomainError(() => decide(app, batch, blankV1.id, 'REJECTED', 'late review'), 'quality.result_not_current');
  // The stale attachment must not satisfy the gate.
  assertDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.control_missing');
  // Attaching the replacement prunes the stale id; the old approval does not carry over.
  app.batches.attachControlResult(batch.id, blankV2.id);
  assert.deepEqual(batch.controlResultIds, [blankV2.id]);
  assertDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.result_unapproved');
  decide(app, batch, blankV2.id, 'APPROVED', 'blank clean');
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});

test('拒绝后重测: retest reopens the run without reusing old pass marks', () => {
  const app = new SampleChainApplication();
  const [member] = bootstrap(app, 1);
  const batch = createBatch(app, [member!.id]);
  startBatch(app, batch);
  const run = completedRun(app, batch);
  const sampleV1 = ingestSample(app, batch, run, member!.id, unique('hash'));
  const blank = ingestControl(app, batch, run, 'BLANK', unique('hash'));
  app.batches.attachControlResult(batch.id, blank.id);
  decide(app, batch, blank.id, 'APPROVED', 'blank clean');
  decide(app, batch, sampleV1.id, 'RETEST_REQUIRED', 'peak shape abnormal');
  assert.equal(batch.status, 'RUNNING');
  // The still-current control survives the transition; approval waits for the retest.
  assert.deepEqual(batch.controlResultIds, [blank.id]);
  assertDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.batch_not_reviewable');
  const rerun = completedRun(app, batch);
  assert.equal(batch.status, 'RESULTS_PENDING');
  // The rejected result is still current and unapproved, so the gate holds.
  assertDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.result_unapproved');
  // The retest supersedes the rejected result and needs its own approval.
  const sampleV2 = ingestSample(app, batch, rerun, member!.id, unique('hash'));
  assert.equal(app.store.results.get(sampleV1.id)!.status, 'SUPERSEDED');
  decide(app, batch, sampleV2.id, 'APPROVED', 'retest within limits');
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});

test('拒绝后重测: rejected batch stays closed and keeps no reusable pass state', () => {
  const app = new SampleChainApplication();
  const [member] = bootstrap(app, 1);
  const batch = createBatch(app, [member!.id]);
  startBatch(app, batch);
  const run = completedRun(app, batch);
  const sample = ingestSample(app, batch, run, member!.id, unique('hash'));
  const blank = ingestControl(app, batch, run, 'BLANK', unique('hash'));
  app.batches.attachControlResult(batch.id, blank.id);
  decide(app, batch, sample.id, 'APPROVED', 'within limits');
  const blankApproval = decide(app, batch, blank.id, 'APPROVED', 'blank clean');
  decide(app, batch, sample.id, 'REJECTED', 'contamination confirmed');
  assert.equal(batch.status, 'REJECTED');
  // Recorded passes cannot be reused: no approval, run, result or new decision.
  assertDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.batch_not_reviewable');
  assertDomainError(() => app.results.registerRun({ tenantId, projectId, batchId: batch.id, externalRunId: unique('RUN'), rawFileHash: 'raw', instrumentSoftwareVersion: 'instrument-7.2', startedAt: STARTED_AT }), 'result.batch_not_running');
  assertDomainError(() => ingestSample(app, batch, run, member!.id, unique('hash')), 'result.batch_not_accepting');
  assertDomainError(() => decide(app, batch, blank.id, 'REJECTED', 'late override'), 'quality.batch_not_reviewable');
  // Replaying an already-recorded decision is still an idempotent no-op.
  const replay = decide(app, batch, blank.id, 'APPROVED', 'blank clean');
  assert.equal(replay.id, blankApproval.id);
});

test('重复批准: re-approval is an idempotent no-op and seals the batch', () => {
  const app = new SampleChainApplication();
  const [member] = bootstrap(app, 1);
  const batch = createBatch(app, [member!.id]);
  startBatch(app, batch);
  const run = completedRun(app, batch);
  const sample = ingestSample(app, batch, run, member!.id, unique('hash'));
  const blank = ingestControl(app, batch, run, 'BLANK', unique('hash'));
  app.batches.attachControlResult(batch.id, blank.id);
  const first = decide(app, batch, sample.id, 'APPROVED', 'within limits');
  const replay = decide(app, batch, sample.id, 'APPROVED', 'within limits');
  assert.equal(replay.id, first.id);
  decide(app, batch, blank.id, 'APPROVED', 'blank clean');
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
  const { approvedAt, version } = batch;
  const auditCount = app.store.audit.length;
  app.quality.approveBatch(batch.id, 'reviewer_02');
  assert.equal(batch.approvedAt, approvedAt);
  assert.equal(batch.version, version);
  assert.equal(app.store.audit.length, auditCount);
  // The approved batch is sealed: no new results, controls or decisions.
  assertDomainError(() => ingestSample(app, batch, run, member!.id, unique('hash')), 'result.batch_not_accepting');
  assertDomainError(() => app.batches.attachControlResult(batch.id, sample.id), 'batch.not_control');
  assertDomainError(() => decide(app, batch, sample.id, 'REJECTED', 'late reversal'), 'quality.batch_not_reviewable');
  // Re-attaching an already attached control remains a no-op.
  app.batches.attachControlResult(batch.id, blank.id);
  assert.equal(batch.version, version);
});

test('批准门槛: control minimums are counted exactly once', () => {
  const app = new SampleChainApplication();
  const [member] = bootstrap(app, 1);
  const batch = createBatch(app, [member!.id], [{ kind: 'BLANK', minimumCount: 2 }]);
  startBatch(app, batch);
  const run = completedRun(app, batch);
  const sample = ingestSample(app, batch, run, member!.id, unique('hash'));
  const blankLead = ingestControl(app, batch, run, 'BLANK', unique('hash'), 'lead');
  app.batches.attachControlResult(batch.id, blankLead.id);
  decide(app, batch, sample.id, 'APPROVED', 'within limits');
  decide(app, batch, blankLead.id, 'APPROVED', 'blank clean');
  // A single blank must not satisfy a minimum of two.
  assertDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.control_missing');
  const blankMercury = ingestControl(app, batch, run, 'BLANK', unique('hash'), 'mercury');
  app.batches.attachControlResult(batch.id, blankMercury.id);
  decide(app, batch, blankMercury.id, 'APPROVED', 'blank clean');
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});

test('批准门槛: every frozen member needs a current result', () => {
  const app = new SampleChainApplication();
  const [first, second] = bootstrap(app, 2);
  const batch = createBatch(app, [first!.id, second!.id]);
  startBatch(app, batch);
  const run = completedRun(app, batch);
  const sample = ingestSample(app, batch, run, first!.id, unique('hash'));
  const blank = ingestControl(app, batch, run, 'BLANK', unique('hash'));
  app.batches.attachControlResult(batch.id, blank.id);
  decide(app, batch, sample.id, 'APPROVED', 'within limits');
  decide(app, batch, blank.id, 'APPROVED', 'blank clean');
  // The second member has no result: the member set cannot be bypassed.
  assertDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.member_missing_result');
  const missing = ingestSample(app, batch, run, second!.id, unique('hash'));
  decide(app, batch, missing.id, 'APPROVED', 'within limits');
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});

test('批准门槛: foreign batch controls and non-control results cannot be attached', () => {
  const app = new SampleChainApplication();
  const aliquots = bootstrap(app, 2);
  const batchA = createBatch(app, [aliquots[0]!.id]);
  const batchB = createBatch(app, [aliquots[1]!.id]);
  startBatch(app, batchA);
  startBatch(app, batchB);
  const runA = completedRun(app, batchA);
  const runB = completedRun(app, batchB);
  const blankA = ingestControl(app, batchA, runA, 'BLANK', unique('hash'));
  const sampleB = ingestSample(app, batchB, runB, aliquots[1]!.id, unique('hash'));
  // A passing control from batch A must not leak into batch B.
  assertDomainError(() => app.batches.attachControlResult(batchB.id, blankA.id), 'scope.forbidden');
  // A normal sample result is not a control.
  assertDomainError(() => app.batches.attachControlResult(batchB.id, sampleB.id), 'batch.not_control');
  assert.deepEqual(batchB.controlResultIds, []);
});

test('批准门槛: results from a failed run cannot enter the batch', () => {
  const app = new SampleChainApplication();
  const [member] = bootstrap(app, 1);
  const batch = createBatch(app, [member!.id]);
  startBatch(app, batch);
  const externalRunId = unique('RUN');
  const failed = app.results.registerRun({ tenantId, projectId, batchId: batch.id, externalRunId, rawFileHash: `raw-${externalRunId}`, instrumentSoftwareVersion: 'instrument-7.2', startedAt: STARTED_AT });
  app.results.completeRun(failed.id, '2026-10-06T12:00:00.000Z', 'FAILED');
  assertDomainError(() => ingestSample(app, batch, failed, member!.id, unique('hash')), 'result.run_not_completed');
  // The analyst retries with a fresh run attempt and the batch recovers.
  const retry = completedRun(app, batch);
  const sample = ingestSample(app, batch, retry, member!.id, unique('hash'));
  const blank = ingestControl(app, batch, retry, 'BLANK', unique('hash'));
  app.batches.attachControlResult(batch.id, blank.id);
  decide(app, batch, sample.id, 'APPROVED', 'within limits');
  decide(app, batch, blank.id, 'APPROVED', 'blank clean');
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});

test('批准门槛: external run id retries are idempotent and conflict across batches', () => {
  const app = new SampleChainApplication();
  const aliquots = bootstrap(app, 2);
  const batchA = createBatch(app, [aliquots[0]!.id]);
  const batchB = createBatch(app, [aliquots[1]!.id]);
  startBatch(app, batchA);
  startBatch(app, batchB);
  const externalRunId = unique('RUN');
  const input = { tenantId, projectId, batchId: batchA.id, externalRunId, rawFileHash: 'raw-1', instrumentSoftwareVersion: 'instrument-7.2', startedAt: STARTED_AT };
  const run = app.results.registerRun(input);
  assert.equal(app.results.registerRun(input).id, run.id);
  assert.equal(app.store.runs.size, 1);
  assertDomainError(() => app.results.registerRun({ ...input, rawFileHash: 'raw-2' }), 'result.run_conflict');
  assertDomainError(() => app.results.registerRun({ ...input, batchId: batchB.id }), 'result.run_conflict');
});

test('规则版本: decisions under a different rule version do not open the gate', () => {
  const app = new SampleChainApplication();
  const [member] = bootstrap(app, 1);
  const batch = createBatch(app, [member!.id]);
  startBatch(app, batch);
  const run = completedRun(app, batch);
  const sample = ingestSample(app, batch, run, member!.id, unique('hash'));
  const blank = ingestControl(app, batch, run, 'BLANK', unique('hash'));
  app.batches.attachControlResult(batch.id, blank.id);
  // Decisions under a foreign rule version are rejected at write time.
  assertDomainError(
    () => app.quality.decide({ tenantId, projectId, batchId: batch.id, resultId: sample.id, decision: 'APPROVED', reason: 'legacy rule', ruleVersion: 'quality-v1', reviewerId: 'reviewer_01' }),
    'quality.rule_version_mismatch',
  );
  decide(app, batch, blank.id, 'APPROVED', 'blank clean');
  // Even a forged historical approval under another rule version cannot open the gate.
  app.store.quality.set('quality_forged', { id: 'quality_forged', tenantId, projectId, batchId: batch.id, resultId: sample.id, decision: 'APPROVED', reason: 'forged', ruleVersion: 'quality-v1', reviewerId: 'reviewer_01', decidedAt: app.store.now(), version: 1 });
  assertDomainError(() => app.quality.approveBatch(batch.id, 'reviewer_01'), 'quality.result_unapproved');
  decide(app, batch, sample.id, 'APPROVED', 'within limits');
  app.quality.approveBatch(batch.id, 'reviewer_01');
  assert.equal(batch.status, 'APPROVED');
});
