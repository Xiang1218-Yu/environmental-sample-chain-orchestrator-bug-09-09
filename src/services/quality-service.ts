import type { QualityDecision, QualityDecisionType } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { Store } from '../store/store.js';

export class QualityService {
  constructor(private readonly store: Store) {}

  decide(input: { tenantId: string; projectId: string; batchId: string; resultId: string; decision: QualityDecisionType; reason: string; ruleVersion: string; reviewerId: string }): QualityDecision {
    const result = assertFound(this.store.results.get(input.resultId), 'quality.result_not_found', 'result not found');
    const batch = assertFound(this.store.batches.get(input.batchId), 'quality.batch_not_found', 'batch not found');
    assertCondition(result.batchId === batch.id && result.projectId === input.projectId && batch.projectId === input.projectId, 'scope.forbidden', 'quality decision is outside the requested project');
    assertCondition(result.status === 'CURRENT', 'quality.result_not_current', 'only the current result revision can be reviewed');
    assertCondition(batch.status === 'RUNNING' || batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW', 'quality.batch_not_reviewable', 'batch is not open for quality review');
    const previous = [...this.store.quality.values()].find((decision) => decision.resultId === result.id && decision.projectId === input.projectId && decision.decision === input.decision && decision.ruleVersion === input.ruleVersion);
    if (previous) return previous;
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
      // Reopen the batch for retest and drop every attached control reference so
      // a previous round's passing controls cannot be reused by the next approval.
      batch.status = 'RUNNING';
      batch.controlResultIds = [];
      batch.version += 1;
      this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'batch.reopened_for_retest', entity: 'batch', entityId: batch.id, metadata: { ruleVersion: input.ruleVersion, reviewerId: input.reviewerId } });
    } else if (input.decision === 'REJECTED') {
      batch.status = 'REJECTED';
      batch.controlResultIds = [];
      batch.version += 1;
    }
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: `quality.${input.decision.toLowerCase()}`, entity: 'result', entityId: result.id, metadata: { batchId: batch.id, ruleVersion: input.ruleVersion, reviewerId: input.reviewerId } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'quality.decision-recorded', aggregateId: result.id, payload: JSON.stringify({ decisionId: decision.id, resultId: result.id, decision: input.decision }) });
    return decision;
  }

  approveBatch(batchId: string, reviewerId: string): void {
    const batch = assertFound(this.store.batches.get(batchId), 'quality.batch_not_found', 'batch not found');
    // Idempotent: re-approving an approved batch is a no-op, not an error and
    // never a second state transition.
    if (batch.status === 'APPROVED') return;
    assertCondition(batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW', 'quality.batch_not_reviewable', 'batch is not ready for approval');
    const currentResults = [...this.store.results.values()].filter((result) => result.batchId === batch.id && result.status === 'CURRENT');
    assertCondition(currentResults.length > 0, 'quality.no_results', 'batch has no current results');
    // Every result must trace back to the member set frozen when the run started.
    const frozenMembers = new Set(batch.frozenMemberAliquotIds ?? batch.memberAliquotIds);
    for (const result of currentResults) {
      if (result.aliquotId !== undefined) {
        assertCondition(frozenMembers.has(result.aliquotId), 'quality.result_outside_members', `result ${result.id} belongs to an aliquot outside the frozen batch members`);
      }
    }
    const approvedResultIds = new Set<string>();
    const rejectedResultIds = new Set<string>();
    for (const decision of this.store.quality.values()) {
      if (decision.batchId !== batch.id) continue;
      if (decision.decision === 'APPROVED') approvedResultIds.add(decision.resultId);
      else rejectedResultIds.add(decision.resultId);
    }
    for (const result of currentResults) {
      assertCondition(approvedResultIds.has(result.id), 'quality.result_unapproved', `result ${result.id} has not been approved`);
      assertCondition(!rejectedResultIds.has(result.id), 'quality.result_rejected', `result ${result.id} carries a rejecting quality decision`);
    }
    // Control gate: only current revisions of this batch, explicitly attached in
    // this round, count. Historical, superseded or foreign control results never
    // satisfy the frozen requirements.
    const attachedControls = new Set(batch.controlResultIds);
    const controlCounts = new Map<string, number>();
    for (const result of currentResults) {
      if (result.controlKind === undefined || !attachedControls.has(result.id)) continue;
      controlCounts.set(result.controlKind, (controlCounts.get(result.controlKind) ?? 0) + 1);
    }
    const requirements = batch.frozenControlRequirements ?? batch.requiredControls;
    for (const requirement of requirements) {
      assertCondition((controlCounts.get(requirement.kind) ?? 0) >= requirement.minimumCount, 'quality.control_missing', `missing control: ${requirement.kind}`);
    }
    batch.status = 'APPROVED';
    batch.approvedAt = this.store.now();
    batch.version += 1;
    this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.approved', entity: 'batch', entityId: batch.id, metadata: { reviewerId, resultCount: currentResults.length } });
    this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.approved', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, reviewerId }) });
  }
}
