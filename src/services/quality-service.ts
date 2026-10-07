import type { AnalysisBatch, QualityDecision, QualityDecisionType } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { Store } from '../store/store.js';

export class QualityService {
  constructor(private readonly store: Store) {}

  decide(input: { tenantId: string; projectId: string; batchId: string; resultId: string; decision: QualityDecisionType; reason: string; ruleVersion: string; reviewerId: string }): QualityDecision {
    const result = assertFound(this.store.results.get(input.resultId), 'quality.result_not_found', 'result not found');
    const batch = assertFound(this.store.batches.get(input.batchId), 'quality.batch_not_found', 'batch not found');
    assertCondition(result.batchId === batch.id && result.projectId === input.projectId && batch.projectId === input.projectId, 'scope.forbidden', 'quality decision is outside the requested project');
    // Idempotent replay: the same decision under the same rule version returns
    // the original record, even if the batch has moved on since then.
    const previous = [...this.store.quality.values()].find((decision) => decision.resultId === result.id && decision.projectId === input.projectId && decision.decision === input.decision && decision.ruleVersion === input.ruleVersion);
    if (previous) return previous;
    assertCondition(result.status === 'CURRENT', 'quality.result_not_current', 'only the current result revision can be reviewed');
    assertCondition(input.ruleVersion === batch.ruleVersion, 'quality.rule_version_mismatch', 'decision rule version does not match the batch rule version');
    assertCondition(batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW', 'quality.batch_not_reviewable', 'batch is not under review');
    const decision: QualityDecision = {
      id: this.store.nextId('quality'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      batchId: input.batchId,
      resultId: input.resultId,
      decision: input.decision,
      reason: input.reason,
      ruleVersion: input.ruleVersion,
      reviewerId: input.reviewerId,
      decidedAt: this.store.now(),
      version: 1,
    };
    this.store.quality.set(decision.id, decision);
    if (input.decision === 'RETEST_REQUIRED') {
      // Send the batch back to RUNNING so a replacement run can be registered;
      // stale control attachments are dropped so the next approval starts clean.
      batch.status = 'RUNNING';
      batch.version += 1;
      this.pruneStaleControls(batch);
    } else if (input.decision === 'REJECTED') {
      batch.status = 'REJECTED';
      batch.version += 1;
      this.pruneStaleControls(batch);
    }
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: `quality.${input.decision.toLowerCase()}`, entity: 'result', entityId: result.id, metadata: { batchId: batch.id, ruleVersion: input.ruleVersion, reviewerId: input.reviewerId } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'quality.decision-recorded', aggregateId: result.id, payload: JSON.stringify({ decisionId: decision.id, resultId: result.id, decision: input.decision }) });
    return decision;
  }

  approveBatch(batchId: string, reviewerId: string): void {
    const batch = assertFound(this.store.batches.get(batchId), 'quality.batch_not_found', 'batch not found');
    // Idempotent: approving an already approved batch changes nothing.
    if (batch.status === 'APPROVED') return;
    assertCondition(batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW', 'quality.batch_not_reviewable', 'batch is not ready for approval');
    const currentResults = [...this.store.results.values()].filter((result) => result.batchId === batch.id && result.status === 'CURRENT');
    assertCondition(currentResults.length > 0, 'quality.no_results', 'batch has no current results');
    // Every frozen member must be covered by at least one current result.
    for (const aliquotId of batch.memberAliquotIds) {
      const covered = currentResults.some((result) => result.aliquotId === aliquotId);
      assertCondition(covered, 'quality.member_missing_result', `member aliquot ${aliquotId} has no current result`);
    }
    // Count each attached control exactly once, and only while it still points
    // at a current control revision of this batch.
    const controlKinds = new Map<string, number>();
    for (const controlId of batch.controlResultIds) {
      const control = this.store.results.get(controlId);
      if (!control || control.batchId !== batch.id || control.status !== 'CURRENT' || !control.controlKind) continue;
      controlKinds.set(control.controlKind, (controlKinds.get(control.controlKind) ?? 0) + 1);
    }
    for (const requirement of batch.requiredControls) {
      assertCondition((controlKinds.get(requirement.kind) ?? 0) >= requirement.minimumCount, 'quality.control_missing', `missing control: ${requirement.kind}`);
    }
    for (const result of currentResults) {
      const approved = [...this.store.quality.values()].some((decision) => decision.resultId === result.id && decision.decision === 'APPROVED' && decision.ruleVersion === batch.ruleVersion);
      assertCondition(approved, 'quality.result_unapproved', `result ${result.id} has not been approved under rule ${batch.ruleVersion}`);
    }
    batch.status = 'APPROVED';
    batch.approvedAt = this.store.now();
    batch.version += 1;
    this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.approved', entity: 'batch', entityId: batch.id, metadata: { reviewerId, resultCount: currentResults.length, memberCount: batch.memberAliquotIds.length, ruleVersion: batch.ruleVersion } });
    this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.approved', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, reviewerId }) });
  }

  private pruneStaleControls(batch: AnalysisBatch): void {
    const retained = batch.controlResultIds.filter((id) => {
      const control = this.store.results.get(id);
      return control !== undefined && control.batchId === batch.id && control.status === 'CURRENT' && control.controlKind !== undefined;
    });
    if (retained.length !== batch.controlResultIds.length) {
      batch.controlResultIds = retained;
      batch.version += 1;
    }
  }
}
