# Environmental Sample Chain Orchestrator

一个从 0-1 构建的环境样本链路编排项目基线，用来管理采样、容器封签、跨机构交接、实验室接收、分装、实验批次、仪器结果修订、质量复核和证据包导出。

## 当前实现

- `src/domain/types.ts`：领域对象、状态和同步模型
- `src/store/store.ts`：内存 Store、全局 ID、审计、Outbox 和事务快照回滚
- `src/services/sampling-service.ts`：采样记录与封存容器
- `src/services/custody-service.ts`：交出、接收、封签和温度轨迹
- `src/services/receiving-service.ts`：实验室接收、接受/隔离/拒收
- `src/services/aliquot-service.ts`：批量分装、单位换算、容量扣减和幂等操作
- `src/services/batch-service.ts`：实验批次成员、协议冻结和运行生命周期
- `src/services/result-service.ts`：仪器运行、外部运行号幂等和结果 revision
- `src/services/quality-service.ts`：质量结论、质控门槛和批次批准
- `src/services/evidence-service.ts`：一致性证据包、清单哈希和冻结
- `src/services/sync-service.ts`：离线 Envelope、客户端序列、payload 冲突和重放
- `src/demo/smoke.ts`：一条可运行的端到端样例

## 运行

```bash
npm install
npm run build
npm run smoke
npm test
```

## 批次 / 质控 / 批准联动约定

- 批次创建时冻结 `ruleVersion`；质控决定与批次批准都必须使用该规则版本，其他版本的决定不计入批准门槛。
- 批次启动先校验全部成员已分配再变更状态，失败的启动不留残态、可直接重试；启动后成员集合冻结，运行期间加入成员会被拒绝并回滚。
- 质控结果只能挂接本批次、当前修订的质控样；重复挂接是幂等空操作；被取代或撤回的历史质控会被清理，不能复用于批准。
- 批准门槛：每个冻结成员至少有一条当前结果；每种必需质控按"本批次 + 当前修订 + 已挂接"恰好计一次；每条当前结果都有本规则版本下的 APPROVED 决定。重复批准是幂等空操作。
- `RETEST_REQUIRED` 把批次退回 RUNNING 以接受重测运行，`REJECTED` 为终态；两者都不会留下可供下一次批准复用的假通过状态。
