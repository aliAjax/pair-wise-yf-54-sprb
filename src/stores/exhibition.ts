import { defineStore } from 'pinia';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export type Role = '保管员' | '借展方';
export type BatchStatus = 'pending' | 'merged' | 'conflict' | 'failed';

export interface Environment { temperature: number; humidity: number; light: number; }

export interface Signature {
  role: Role;
  deviceId: string;
  signedAt: number;
  exhibitVersion: number;
  contentHash: string;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  signed: Signature[];
  environment: Environment;
  attachments: string[];
  version: number;
  source?: string;
  returned?: boolean;
}

export interface Discrepancy {
  id: string;
  exhibitId: string;
  title: string;
  severity: 'minor' | 'major';
  resolved: boolean;
}

export interface FieldChange { field: string; before: unknown; after: unknown; }

export interface FieldConflict {
  field: string;
  baseValue: unknown;
  localValue: unknown;   // 离线改后的值（两版之一）
  serverValue: unknown;  // 回网时服务端现值（两版之一）
  resolution?: 'local' | 'server';
}

export interface OfflineBatch {
  id: string;            // 离线编号
  deviceId: string;      // 设备号
  exhibitId: string;
  baseVersion: number;   // 基线版本
  changes: FieldChange[];
  createdAt: number;
  status: BatchStatus;
  error?: string;
  conflicts?: FieldConflict[];
}

interface State {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  batches: OfflineBatch[];
  deviceId: string;
  borrowerDeviceId: string;
}

export const STORAGE_KEY = 'yf54-exhibition-state';

export const stageLabel = (stage: Stage): string => ({ arrival: '到场点交', install: '布展核验', return: '闭展归还' })[stage];
export const roleLabel = (role: Role): string => role;

/** 对展品可签字内容（环境、附件、差异项）计算哈希，用于签字绑定。 */
export function contentHash(exhibit: Exhibit, discrepancies: Discrepancy[]): string {
  const payload = JSON.stringify({
    environment: exhibit.environment,
    attachments: [...exhibit.attachments].sort(),
    discrepancies: discrepancies
      .filter((item) => item.exhibitId === exhibit.id)
      .map((item) => [item.id, item.title, item.severity, item.resolved])
  });
  let h = 0;
  for (let i = 0; i < payload.length; i += 1) h = (Math.imul(h, 31) + payload.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function getField(target: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => (obj as Record<string, unknown> | null)?.[key], target);
}
function setField(target: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const host = keys.reduce<unknown>((obj, key) => (obj as Record<string, unknown>)[key], target);
  (host as Record<string, unknown>)[last] = value;
}

function genDeviceId(): string {
  return `device-${Math.random().toString(36).slice(2, 8)}`;
}
function genOfflineId(): string {
  return `off-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function rehashSignatures(exhibits: Exhibit[], discrepancies: Discrepancy[]): void {
  for (const exhibit of exhibits) {
    for (const signature of exhibit.signed) {
      signature.exhibitVersion = exhibit.version;
      signature.contentHash = contentHash(exhibit, discrepancies);
    }
  }
}

function seedState(): State {
  const exhibits: Exhibit[] = Array.from({ length: 24 }, (_, index) => ({
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
    signed: [] as Signature[],
    environment: { temperature: 20 + (index % 3), humidity: 48 + (index % 8), light: 120 + index * 3 },
    attachments: index % 2 ? ['封条', '交接单'] : ['封条', '开箱记录', '照片'],
    version: 1
  }));
  // 签字：保管员与借展方使用不同设备，避免被判定为同设备越权代签。
  exhibits.forEach((exhibit, index) => {
    if (index < 5) {
      exhibit.signed.push({ role: '保管员', deviceId: 'seed-keeper', signedAt: 0, exhibitVersion: 1, contentHash: '' });
      exhibit.signed.push({ role: '借展方', deviceId: 'seed-borrower', signedAt: 0, exhibitVersion: 1, contentHash: '' });
    } else if (index < 10) {
      exhibit.signed.push({ role: '保管员', deviceId: 'seed-keeper', signedAt: 0, exhibitVersion: 1, contentHash: '' });
    }
  });
  const discrepancies: Discrepancy[] = [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
  ];
  rehashSignatures(exhibits, discrepancies);
  return { exhibits, discrepancies, batches: [], deviceId: genDeviceId(), borrowerDeviceId: genDeviceId() };
}

/** 升级兼容：旧版本签字为 string[]，补设备、版本、哈希并登记来源记录。 */
function migrate(raw: unknown): State {
  if (!raw || typeof raw !== 'object') return seedState();
  const data = raw as Record<string, unknown>;
  const exhibits = Array.isArray(data.exhibits) ? (data.exhibits as Exhibit[]) : [];
  const discrepancies = Array.isArray(data.discrepancies) ? (data.discrepancies as Discrepancy[]) : [];
  for (const exhibit of exhibits) {
    exhibit.version = typeof exhibit.version === 'number' ? exhibit.version : 1;
    exhibit.attachments = Array.isArray(exhibit.attachments) ? exhibit.attachments : [];
    exhibit.returned = Boolean(exhibit.returned);
    const signed = exhibit.signed as unknown;
    if (Array.isArray(signed)) {
      const first = signed[0] as unknown;
      if (typeof first === 'string') {
        const roles = signed as unknown as Role[];
        exhibit.signed = roles.map((role) => ({
          role,
          deviceId: role === '保管员' ? 'legacy-keeper' : 'legacy-borrower',
          signedAt: 0,
          exhibitVersion: exhibit.version,
          contentHash: ''
        }));
        exhibit.source = `升级补录：按现有签字（${roles.join('、')}）与阶段（${stageLabel(exhibit.stage)}）补录来源记录`;
      }
    } else {
      exhibit.signed = [];
    }
  }
  rehashSignatures(exhibits, discrepancies);
  return {
    exhibits,
    discrepancies,
    batches: Array.isArray(data.batches) ? (data.batches as OfflineBatch[]) : [],
    deviceId: typeof data.deviceId === 'string' ? data.deviceId : genDeviceId(),
    borrowerDeviceId: typeof data.borrowerDeviceId === 'string' ? data.borrowerDeviceId : genDeviceId()
  };
}

function load(): State {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      return migrate(JSON.parse(saved));
    } catch {
      /* 解析失败则回退到种子数据 */
    }
  }
  return seedState();
}

export const useExhibitionStore = defineStore('exhibition', {
  state: (): State => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({
      arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
      install: state.exhibits.filter((item) => item.stage === 'install').length,
      return: state.exhibits.filter((item) => item.stage === 'return').length
    }),
    pendingBatches: (state) => state.batches.filter((batch) => batch.status === 'pending'),
    failedBatches: (state) => state.batches.filter((batch) => batch.status === 'failed'),
    conflictBatches: (state) => state.batches.filter((batch) => batch.status === 'conflict'),
    queuedCount(): number {
      return this.pendingBatches.length + this.failedBatches.length + this.conflictBatches.length;
    },
    /** 叠加本地离线改动后的展示展品（草稿仅用于显示，合并后才写入正式内容）。 */
    displayExhibit: (state) => (id: string): Exhibit | null => {
      const exhibit = state.exhibits.find((item) => item.id === id);
      if (!exhibit) return null;
      const draft = JSON.parse(JSON.stringify(exhibit)) as Exhibit;
      for (const batch of state.batches
        .filter((item) => item.exhibitId === id && item.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)) {
        for (const change of batch.changes) setField(draft, change.field, change.after);
      }
      return draft;
    },
    pendingChangesFor: (state) => (exhibitId: string) =>
      state.batches
        .filter((batch) => batch.exhibitId === exhibitId && batch.status === 'pending')
        .flatMap((batch) => batch.changes.map((change) => ({ batchId: batch.id, field: change.field, after: change.after }))),
    /** 签字是否仍绑定当前展品内容：版本一致且哈希一致。 */
    signatureValid: (state) => (exhibit: Exhibit, signature: Signature): boolean =>
      signature.exhibitVersion === exhibit.version && signature.contentHash === contentHash(exhibit, state.discrepancies),
    /** 推进/归还门禁：返回未通过原因，空数组表示可放行。 */
    gateReasons: (state) => (exhibitId: string): string[] => {
      const exhibit = state.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return ['展品不存在'];
      const reasons: string[] = [];
      if (state.discrepancies.some((item) => item.exhibitId === exhibitId && !item.resolved)) {
        reasons.push('存在未解决的差异项');
      }
      if (state.batches.some((item) => item.exhibitId === exhibitId && item.status === 'pending')) {
        reasons.push('有未合并的离线批次，请先回网同步');
      }
      const conflict = state.batches.find(
        (item) => item.exhibitId === exhibitId && item.status === 'conflict' && item.conflicts?.some((c) => !c.resolution)
      );
      if (conflict) reasons.push('存在未确认的字段冲突（两版待确认）');
      const keeper = exhibit.signed.find((item) => item.role === '保管员');
      const borrower = exhibit.signed.find((item) => item.role === '借展方');
      if (!keeper) reasons.push('缺少保管员签字');
      if (!borrower) reasons.push('缺少借展方签字');
      if (keeper && borrower && keeper.deviceId === borrower.deviceId) {
        reasons.push('检测到双方签字来自同一设备，疑似借展方越权代签');
      }
      for (const signature of exhibit.signed) {
        if (signature.exhibitVersion !== exhibit.version || signature.contentHash !== contentHash(exhibit, state.discrepancies)) {
          reasons.push(`${signature.role}签字已失效（内容或版本在签字后变更），请重新签字`);
        }
      }
      return reasons;
    }
  },
  actions: {
    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state));
    },
    /** 离线字段改动：按字段记录 before/after、设备号与基线版本，生成离线批次。 */
    editExhibit(id: string, patch: Record<string, unknown>) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      const draft = this.displayExhibit(id)!;
      const changes: FieldChange[] = [];
      for (const [field, after] of Object.entries(patch)) {
        const before = getField(draft, field);
        if (!deepEqual(before, after)) changes.push({ field, before, after });
      }
      if (!changes.length) return;
      this.batches.push({
        id: genOfflineId(),
        deviceId: this.deviceId,
        exhibitId: id,
        baseVersion: exhibit.version,
        changes,
        createdAt: Date.now(),
        status: 'pending'
      });
      this.persist();
    },
    setCondition(id: string, status: CheckStatus) {
      this.editExhibit(id, { status });
    },
    sign(id: string, role: Role, deviceId?: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) return;
      const signature: Signature = {
        role,
        deviceId: deviceId ?? this.deviceId,
        signedAt: Date.now(),
        exhibitVersion: exhibit.version,
        contentHash: contentHash(exhibit, this.discrepancies)
      };
      exhibit.signed = exhibit.signed.filter((item) => item.role !== role);
      exhibit.signed.push(signature);
      this.persist();
    },
    advance(id: string): { ok: boolean; reasons: string[] } {
      const reasons = this.gateReasons(id);
      if (reasons.length) return { ok: false, reasons };
      const exhibit = this.exhibits.find((item) => item.id === id)!;
      exhibit.stage = exhibit.stage === 'arrival' ? 'install' : exhibit.stage === 'install' ? 'return' : 'return';
      this.persist();
      return { ok: true, reasons: [] };
    },
    completeReturn(id: string): { ok: boolean; reasons: string[] } {
      const reasons = this.gateReasons(id);
      if (reasons.length) return { ok: false, reasons };
      const exhibit = this.exhibits.find((item) => item.id === id)!;
      exhibit.returned = true;
      this.persist();
      return { ok: true, reasons: [] };
    },
    resolveDiscrepancy(id: string) {
      const item = this.discrepancies.find((entry) => entry.id === id);
      if (item) {
        item.resolved = true;
        // 差异项属于签字绑定内容，变更后已有签字立即失效。
        const exhibit = this.exhibits.find((entry) => entry.id === item.exhibitId);
        if (exhibit) exhibit.version += 1;
        this.persist();
      }
    },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      this.exhibits.unshift({
        id: `ex-${Date.now()}`,
        ...payload,
        stage: 'arrival',
        status: 'pending',
        signed: [],
        environment: { temperature: 20, humidity: 50, light: 150 },
        attachments: [],
        version: 1
      });
      this.persist();
    },
    /** 回网合并：逐字段比对基线，不同字段各自保留，同字段冲突则留两版待确认。 */
    mergeBatch(batch: OfflineBatch) {
      const exhibit = this.exhibits.find((item) => item.id === batch.exhibitId);
      if (!exhibit) {
        batch.status = 'failed';
        batch.error = '展品不存在，可能已被删除';
        this.persist();
        return;
      }
      const conflicts: FieldConflict[] = [];
      let applied = 0;
      for (const change of batch.changes) {
        const current = getField(exhibit, change.field);
        if (deepEqual(current, change.before)) {
          setField(exhibit, change.field, change.after);
          applied += 1;
        } else if (deepEqual(current, change.after)) {
          // 与服务端现值一致（幂等），无需重复写入。
        } else {
          conflicts.push({ field: change.field, baseValue: change.before, localValue: change.after, serverValue: current });
        }
      }
      if (conflicts.length) {
        batch.status = 'conflict';
        batch.conflicts = conflicts;
        batch.error = undefined;
      } else {
        batch.status = 'merged';
        batch.conflicts = undefined;
        if (applied) exhibit.version += 1;
      }
      this.persist();
    },
    /** 合并失败后按离线编号重试。 */
    retryBatch(id: string) {
      const batch = this.batches.find((item) => item.id === id);
      if (!batch) return;
      batch.status = 'pending';
      batch.error = undefined;
      batch.conflicts = undefined;
      this.mergeBatch(batch);
    },
    /** 确认字段冲突采用哪一版（local 离线版 / server 服务端版）。 */
    resolveConflict(batchId: string, field: string, resolution: 'local' | 'server') {
      const batch = this.batches.find((item) => item.id === batchId);
      const conflict = batch?.conflicts?.find((item) => item.field === field);
      if (!batch || !conflict || conflict.resolution) return;
      const exhibit = this.exhibits.find((item) => item.id === batch.exhibitId);
      if (!exhibit) return;
      if (resolution === 'local') setField(exhibit, field, conflict.localValue);
      conflict.resolution = resolution;
      if (batch.conflicts!.every((item) => item.resolution)) {
        batch.status = 'merged';
        batch.conflicts = undefined;
        exhibit.version += 1;
      }
      this.persist();
    },
    /** 模拟对端设备（借展方）在另一台设备上的改动，用于演示回网字段合并。 */
    simulateServerChange(exhibitId: string, field: string, value: unknown) {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return;
      setField(exhibit, field, value);
      exhibit.version += 1;
      this.persist();
    },
    /** 回网同步：合并所有待处理（含失败重试）批次。 */
    syncQueue(): { merged: number; conflict: number; failed: number } {
      const result = { merged: 0, conflict: 0, failed: 0 };
      for (const batch of [...this.batches]) {
        if (batch.status !== 'pending' && batch.status !== 'failed') continue;
        this.mergeBatch(batch);
        const status = batch.status as BatchStatus;
        if (status === 'merged') result.merged += 1;
        else if (status === 'conflict') result.conflict += 1;
        else if (status === 'failed') result.failed += 1;
      }
      return result;
    }
  }
});
