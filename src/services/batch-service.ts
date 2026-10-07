import type { AnalysisBatch, ControlRequirement } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { Store } from '../store/store.js';
import { AliquotService } from './aliquot-service.js';

export interface CreateBatchInput {
  tenantId: string;
  projectId: string;
  protocolVersion: string;
  instrumentType: string;
  ruleVersion: string;
  requiredControls: ControlRequirement[];
  createdBy: string;
}

export class BatchService {
  constructor(private readonly store: Store, private readonly aliquots: AliquotService) {}

  create(input: CreateBatchInput): AnalysisBatch {
    assertCondition(input.requiredControls.every((control) => control.minimumCount > 0), 'batch.invalid_controls', 'control minimums must be positive');
    const batch: AnalysisBatch = {
      id: this.store.nextId('batch'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      protocolVersion: input.protocolVersion,
      instrumentType: input.instrumentType,
      ruleVersion: input.ruleVersion,
      status: 'DRAFT',
      memberAliquotIds: [],
      requiredControls: structuredClone(input.requiredControls),
      controlResultIds: [],
      createdBy: input.createdBy,
      createdAt: this.store.now(),
      version: 1,
    };
    this.store.batches.set(batch.id, batch);
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'batch.created', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: input.protocolVersion, ruleVersion: input.ruleVersion } });
    return batch;
  }

  addAliquot(batchId: string, aliquotId: string): AnalysisBatch {
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
    assertCondition(batch.tenantId === aliquot.tenantId && batch.projectId === aliquot.projectId, 'scope.forbidden', 'batch and aliquot belong to different projects');
    // Idempotent replay: an aliquot that is already a member is a no-op, even
    // if the batch has moved on since the original request.
    if (batch.memberAliquotIds.includes(aliquotId)) return batch;
    assertCondition(batch.status === 'DRAFT' || batch.status === 'READY', 'batch.members_locked', 'batch members are locked after execution starts');
    this.aliquots.allocate(aliquotId, batchId);
    batch.memberAliquotIds.push(aliquotId);
    batch.version += 1;
    return batch;
  }

  markReady(batchId: string): AnalysisBatch {
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    assertCondition(batch.status === 'DRAFT' && batch.memberAliquotIds.length > 0, 'batch.not_ready', 'batch needs at least one aliquot before it can be prepared');
    batch.status = 'READY';
    batch.version += 1;
    this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.ready', entity: 'batch', entityId: batch.id, metadata: { memberCount: batch.memberAliquotIds.length } });
    return batch;
  }

  start(batchId: string, startedAt: string): AnalysisBatch {
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    assertCondition(batch.status === 'READY', 'batch.invalid_start', 'only ready batches can start');
    // Validate every member before mutating any state, so a failed start leaves
    // the batch untouched and the same start can be retried safely.
    for (const aliquotId of batch.memberAliquotIds) {
      const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'batch member aliquot not found');
      assertCondition(aliquot.status === 'ALLOCATED', 'batch.member_not_allocated', 'all batch members must be allocated');
    }
    batch.status = 'RUNNING';
    batch.startedAt = startedAt;
    batch.frozenAt = startedAt;
    batch.version += 1;
    this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.started', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: batch.protocolVersion, memberCount: batch.memberAliquotIds.length } });
    this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.started', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, version: batch.version }) });
    return batch;
  }

  attachControlResult(batchId: string, resultId: string): AnalysisBatch {
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    const result = assertFound(this.store.results.get(resultId), 'result.not_found', 'control result not found');
    assertCondition(result.batchId === batch.id && result.tenantId === batch.tenantId && result.projectId === batch.projectId, 'scope.forbidden', 'control result belongs to a different batch');
    assertCondition(result.controlKind !== undefined, 'batch.not_control', 'only control results can be attached to a batch');
    const attachable = batch.status === 'RUNNING' || batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW';
    if (!attachable) {
      // Idempotent replay of an earlier successful attach is a no-op; a new
      // attach is rejected once the batch has left the execution lifecycle.
      assertCondition(batch.controlResultIds.includes(resultId), 'batch.controls_locked', 'control results cannot be attached in the current batch state');
      return batch;
    }
    assertCondition(result.status === 'CURRENT', 'batch.control_not_current', 'only the current control revision can be attached');
    // Drop attachments that no longer point at a current control of this batch,
    // so a superseded or withdrawn pass can never be reused by the gate.
    const retained = batch.controlResultIds.filter((id) => {
      const attached = this.store.results.get(id);
      return attached !== undefined && attached.batchId === batch.id && attached.status === 'CURRENT' && attached.controlKind !== undefined;
    });
    // Idempotent: re-attaching the same control after a failed upload is a no-op.
    if (!retained.includes(resultId)) retained.push(resultId);
    const changed = retained.length !== batch.controlResultIds.length || !batch.controlResultIds.includes(resultId);
    batch.controlResultIds = retained;
    if (changed) batch.version += 1;
    return batch;
  }
}
