import { defineStore } from 'pinia';
import {
  type Attachment, type DeviceInfo, type Discrepancy, type Exhibit, type FieldName,
  type OfflineBatch, type OfflineOp, type Role, type Signature, type SourceRecord, type Stage,
  type CheckStatus, contentHashOf, evaluateGate, getField, uid
} from '../services/offline';
import {
  type CanonicalState, type ViewState, mergeOpenBatches, projectView,
  replayBatch, resolveConflict as resolveConflictEngine, retryBatch as retryBatchEngine, shortId
} from '../services/merge';
import { migrateV1Data } from '../services/migration';

export type { Exhibit, FieldName, Discrepancy, Signature, OfflineBatch, OfflineOp } from '../services/offline';

interface PersistState extends CanonicalState {
  schema: number;
  online: boolean;
  currentDeviceId: string;
  queued: number;
}

const STORAGE_KEY = 'yf54-exhibition-state-v2';
const DEVICE_KEY = 'yf54-device-id';

const DEVICES: Record<string, DeviceInfo> = {
  'dev-keeper-a': { id: 'dev-keeper-a', label: '保管员掌机 A', role: '保管员' },
  'dev-keeper-b': { id: 'dev-keeper-b', label: '保管员工位 B', role: '保管员' },
  'dev-lender-a': { id: 'dev-lender-a', label: '借展方平板 L', role: '借展方' }
};

const EMPTY_REVISIONS = (): Record<FieldName, undefined> => ({
  status: undefined, conditionNote: undefined, temperature: undefined, humidity: undefined,
  light: undefined, hall: undefined, note: undefined
});

function makeSeedExhibit(index: number): Exhibit {
  return {
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
    version: 1,
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
    conditionNote: '',
    note: '',
    environment: { temperature: 20 + index % 3, humidity: 48 + index % 8, light: 120 + index * 3 },
    attachments: [],
    returnedAt: null,
    fieldRevisions: EMPTY_REVISIONS()
  };
}

const seedDiscrepancies: Discrepancy[] = [
  { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
  { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
];

function freshState(): PersistState {
  const exhibits = Array.from({ length: 24 }, (_, index) => makeSeedExhibit(index));
  return {
    schema: 2,
    online: true,
    currentDeviceId: 'dev-keeper-a',
    exhibits,
    discrepancies: seedDiscrepancies.map((item) => ({ ...item })),
    signatures: [],
    conflicts: [],
    sources: [],
    devices: JSON.parse(JSON.stringify(DEVICES)),
    batches: [],
    queued: 0
  };
}

/** v1（旧版只有 signed 角色数组）迁移：版本归 1，按现有签字和阶段补签字与来源记录 */
function migrateV1(raw: Record<string, unknown>, now: number): PersistState {
  const next = freshState();
  const migrated = migrateV1Data(raw, now);
  next.exhibits = migrated.exhibits;
  next.discrepancies = migrated.discrepancies;
  next.signatures = migrated.signatures;
  next.sources = migrated.sources;
  return next;
}

function load(): PersistState {
  const now = Date.now();
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as PersistState;
      if (parsed.schema === 2) return { ...freshState(), ...parsed };
    }
    // 兼容旧 key
    const legacy = localStorage.getItem('yf54-exhibition-state');
    if (legacy) {
      const migrated = migrateV1(JSON.parse(legacy) as Record<string, unknown>, now);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch (error) {
    console.warn('状态读取失败，使用内置示例', error);
  }
  return freshState();
}

export const useExhibitionStore = defineStore('exhibition', {
  state: (): PersistState => load(),
  getters: {
    currentDevice(state): DeviceInfo { return state.devices[state.currentDeviceId] ?? DEVICES['dev-keeper-a']; },
    /** 当前设备视角：自己的离线批次已叠加，别台设备未回网的改动不可见 */
    view(state): ViewState { return projectView(state as unknown as CanonicalState, state.currentDeviceId); },
    openBatch(state): OfflineBatch | undefined {
      return state.batches.find((batch) => batch.deviceId === state.currentDeviceId && batch.status === 'open');
    },
    openBatches(state): OfflineBatch[] { return state.batches.filter((batch) => batch.status === 'open'); },
    blockedBatches(state): OfflineBatch[] { return state.batches.filter((batch) => batch.status === 'blocked'); },
    unresolved(state): number { return state.discrepancies.filter((item) => !item.resolved).length; },
    pendingConflicts(state) { return state.conflicts.filter((item) => item.resolvedOpId === null); },
    stageCounts(state) {
      return {
        arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
        install: state.exhibits.filter((item) => item.stage === 'install').length,
        return: state.exhibits.filter((item) => item.stage === 'return' && !item.returnedAt).length
      };
    }
  },
  actions: {
    persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state)); },

    setOnline(value: boolean) {
      this.online = value;
      if (value) this.mergeAll();
      this.persist();
    },
    switchDevice(deviceId: string) {
      this.currentDeviceId = deviceId;
      localStorage.setItem(DEVICE_KEY, deviceId);
      this.persist();
    },

    /** 当前设备视角下展品的门禁结果 */
    gateFor(exhibitId: string) {
      const view = this.view;
      const exhibit = view.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return { ok: false as const, code: 'missingKeeper' as const, message: '展品不存在' };
      return evaluateGate(exhibit, view.signatures, view.discrepancies, this.conflicts);
    },
    canonGateFor(exhibitId: string) {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return { ok: false, code: 'missingKeeper' as const, message: '展品不存在' };
      return evaluateGate(exhibit, this.signatures, this.discrepancies, this.conflicts);
    },

    /** 取当前设备未合并批次（没有则开一个），操作入队 */
    queueOp(partial: Omit<OfflineOp, 'id' | 'deviceId' | 'at' | 'status'>): { batch: OfflineBatch; op: OfflineOp; merged: boolean } {
      const now = Date.now();
      let batch = this.batches.find((item) => item.deviceId === this.currentDeviceId && item.status === 'open');
      if (!batch) {
        batch = { id: uid('batch'), deviceId: this.currentDeviceId, openedAt: now, closedAt: null, status: 'open', ops: [] };
        this.batches.push(batch);
      }
      const op: OfflineOp = { ...partial, id: uid('op'), deviceId: this.currentDeviceId, at: now, status: 'queued' };
      batch.ops.push(op);
      this.queued = this.batches.reduce((sum, item) => sum + (item.status === 'open' ? item.ops.filter((entry) => entry.status === 'queued').length : 0), 0);
      this.persist();

      // 在线时单条立即回网合并；离线时留在本地批次，回网后按 openedAt 顺序合并
      if (this.online) {
        replayBatch(this.$state as unknown as CanonicalState, batch, Date.now());
        this.queued = this.batches.reduce((sum, item) => sum + (item.status === 'open' ? item.ops.filter((entry) => entry.status === 'queued').length : 0), 0);
        this.persist();
        return { batch, op, merged: true };
      }
      return { batch, op, merged: false };
    },

    /** 记录字段改动：记下字段、设备号与基线版本（当前已提交值） */
    recordEdit(exhibitId: string, field: FieldName, value: string): void {
      const canon = this.exhibits.find((item) => item.id === exhibitId);
      if (!canon) return;
      // 同一批次同一字段多次修改，基线锚定首次修改前的值
      const batch = this.batches.find((item) => item.deviceId === this.currentDeviceId && item.status === 'open');
      const prior = batch?.ops.find((op) => op.exhibitId === exhibitId && op.field === field && op.status === 'queued');
      const baselineValue = prior?.baseline?.value ?? getField(canon, field);
      this.queueOp({ type: 'edit', exhibitId, field, value, baseline: { field, value: baselineValue } });
    },

    recordCondition(exhibitId: string, status: CheckStatus) { this.recordEdit(exhibitId, 'status', status); },

    recordAttachment(exhibitId: string, name: string) {
      const attachment: Attachment = { id: uid('att'), name };
      this.queueOp({ type: 'addAttachment', exhibitId, attachment });
    },
    removeAttachment(exhibitId: string, attachmentId: string) {
      this.queueOp({ type: 'removeAttachment', exhibitId, attachmentId });
    },
    addDiscrepancy(exhibitId: string, title: string, severity: 'minor' | 'major') {
      const discrepancy = { id: uid('d'), exhibitId, title, severity, resolved: false };
      this.queueOp({ type: 'discrepancyAdd', exhibitId, discrepancy });
    },
    resolveDiscrepancy(id: string) {
      const item = this.discrepancies.find((entry) => entry.id === id)
        ?? this.view.discrepancies.find((entry) => entry.id === id);
      if (!item || item.resolved) return;
      this.queueOp({ type: 'discrepancyResolve', exhibitId: item.exhibitId, discrepancyId: id });
    },

    /** 签字：绑定当时展品内容哈希、阶段与基线版本；角色不匹配当场拒绝 */
    recordSign(exhibitId: string, role: Role): { ok: boolean; message: string } {
      const device = this.currentDevice;
      if (device.role !== role) {
        return { ok: false, message: `越权拦截：${device.label}（${device.role}）不能替${role}签字` };
      }
      const view = this.view;
      const exhibit = view.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return { ok: false, message: '展品不存在' };
      const exists = view.signatures.some((sig) => sig.exhibitId === exhibitId && sig.stage === exhibit.stage && sig.role === role);
      if (exists) return { ok: false, message: `${role}已在当前内容上签字` };
      this.queueOp({
        type: 'sign',
        exhibitId,
        role,
        stage: exhibit.stage,
        baseVersion: exhibit.version,
        contentHash: contentHashOf(exhibit, view.discrepancies)
      });
      return { ok: true, message: `${role}已签字，绑定 ${shortStage(exhibit.stage)} 内容 v${exhibit.version}` };
    },

    recordAdvance(exhibitId: string) {
      const gate = this.gateFor(exhibitId);
      if (!gate.ok) return { ok: false as const, message: gate.message, merged: false };
      const result = this.queueOp({ type: 'advance', exhibitId });
      return { ok: true as const, message: '推进操作已入队', merged: result.merged };
    },
    recordReturn(exhibitId: string) {
      const gate = this.gateFor(exhibitId);
      if (!gate.ok) return { ok: false as const, message: gate.message, merged: false };
      const result = this.queueOp({ type: 'return', exhibitId });
      return { ok: true as const, message: '归还确认已入队', merged: result.merged };
    },

    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      const now = Date.now();
      const snapshot: Exhibit = {
        ...makeSeedExhibit(0),
        id: `ex-${now.toString(36)}`,
        ...payload,
        stage: 'arrival',
        version: 1,
        status: 'pending'
      };
      this.queueOp({ type: 'create', exhibitId: snapshot.id, snapshot });
      return snapshot.id;
    },

    /** 回网：按离线编号顺序合并所有未合并批次 */
    mergeAll() {
      const merged = mergeOpenBatches(this.$state as unknown as CanonicalState, Date.now());
      this.queued = this.batches.reduce((sum, item) => sum + (item.status === 'open' ? item.ops.filter((entry) => entry.status === 'queued').length : 0), 0);
      this.persist();
      return merged;
    },
    /** 合并失败的批次本地不丢，按离线编号重试 */
    retryBatch(batchId: string) {
      const ok = retryBatchEngine(this.$state as unknown as CanonicalState, batchId, Date.now());
      this.persist();
      return ok;
    },
    resolveConflict(conflictId: string, chosenOpId: string) {
      resolveConflictEngine(this.$state as unknown as CanonicalState, conflictId, chosenOpId, Date.now());
      this.queued = this.batches.reduce((sum, item) => sum + (item.status === 'open' ? item.ops.filter((entry) => entry.status === 'queued').length : 0), 0);
      this.persist();
    },
    syncQueue() {
      this.mergeAll();
      this.persist();
    }
  }
});

function shortStage(stage: Stage): string {
  return stage === 'arrival' ? '到场点交' : stage === 'install' ? '布展核验' : '闭展归还';
}

export type { SourceRecord };
