// 离线续作核心：字段级变更记录、基线版本、设备视图、内容哈希与签字校验

export type Role = '保管员' | '借展方';
export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export type FieldName = 'status' | 'conditionNote' | 'temperature' | 'humidity' | 'light' | 'hall' | 'note';
export type OpType = 'create' | 'edit' | 'sign' | 'addAttachment' | 'removeAttachment' | 'discrepancyAdd' | 'discrepancyResolve' | 'advance' | 'return';
export type OpStatus = 'queued' | 'applied' | 'conflict' | 'blocked' | 'superseded' | 'invalid';
export type BatchStatus = 'open' | 'merged' | 'blocked';

export interface Attachment { id: string; name: string; }
export interface Signature {
  exhibitId: string;
  stage: Stage;
  role: Role;
  deviceId: string;
  at: number;
  baseVersion: number;
  contentHash: string;
  source: 'live' | 'batch' | 'migration';
}
export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  version: number;
  status: CheckStatus;
  conditionNote: string;
  note: string;
  environment: { temperature: number; humidity: number; light: number };
  attachments: Attachment[];
  returnedAt: number | null;
  /** 各字段最后写入来源（设备/操作/时间），合并时据此判定基线 */
  fieldRevisions: Record<FieldName, FieldRevision | undefined>;
}
export interface FieldRevision { deviceId: string; opId: string; at: number; }
export interface Discrepancy { id: string; exhibitId: string; title: string; severity: 'minor' | 'major'; resolved: boolean; }
export interface SourceRecord { id: string; exhibitId: string; at: number; kind: 'created' | 'migrated' | 'merge' | 'resolve' | 'returned' | 'advanced'; detail: string; }

export interface OfflineOp {
  id: string;
  type: OpType;
  exhibitId: string;
  deviceId: string;
  at: number;
  /** 该操作落键时所依据的字段基线值 */
  baseline?: { field: FieldName; value: string };
  field?: FieldName;
  value?: string;
  role?: Role;
  stage?: Stage;
  baseVersion?: number;
  contentHash?: string;
  snapshot?: Exhibit;
  attachment?: Attachment;
  attachmentId?: string;
  discrepancy?: Discrepancy;
  discrepancyId?: string;
  status: OpStatus;
  appliedAt?: number;
  conflictId?: string;
  blockReason?: string;
}
export interface OfflineBatch {
  id: string;
  deviceId: string;
  openedAt: number;
  closedAt: number | null;
  status: BatchStatus;
  ops: OfflineOp[];
  mergedAt?: number;
  note?: string;
}
export interface Conflict {
  id: string;
  exhibitId: string;
  field: FieldName;
  baseValue: string;
  versions: ConflictVersion[];
  resolvedOpId: string | null;
  resolvedValue: string | null;
  createdAt: number;
  resolvedAt: number | null;
}
export interface ConflictVersion { opId: string; deviceId: string; value: string; at: number; }
export interface DeviceInfo { id: string; label: string; role: Role; }

export const FIELD_LABELS: Record<FieldName, string> = {
  status: '条件结论',
  conditionNote: '条件说明',
  temperature: '温度',
  humidity: '湿度',
  light: '照度',
  hall: '展厅/柜位',
  note: '处理意见'
};

export const STAGE_LABELS: Record<Stage, string> = { arrival: '到场点交', install: '布展核验', return: '闭展归还' };

export function getField(exhibit: Exhibit, field: FieldName): string {
  if (field === 'temperature') return String(exhibit.environment.temperature);
  if (field === 'humidity') return String(exhibit.environment.humidity);
  if (field === 'light') return String(exhibit.environment.light);
  return exhibit[field];
}

export function setField(exhibit: Exhibit, field: FieldName, raw: string): void {
  if (field === 'temperature' || field === 'humidity' || field === 'light') {
    exhibit.environment[field] = Number(raw);
  } else if (field === 'status') {
    exhibit.status = raw as CheckStatus;
  } else {
    exhibit[field] = raw;
  }
  exhibit.version += 1;
}

export function fieldRevisionKey(field: FieldName): string { field; return field; }

/** 稳定的结构化哈希：签字内容与当前内容逐字节一致才算有效 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

export function hashContent(value: unknown): string {
  const text = stableStringify(value);
  // FNV-1a 32 位，本地内容指纹，无需密码学强度
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 签字绑定的展品内容：条件结论/说明、环境、附件、差异项、处理意见，加上阶段与版本 */
export function signaturePayload(exhibit: Exhibit, discrepancies: Discrepancy[]) {
  return {
    id: exhibit.id,
    stage: exhibit.stage,
    version: exhibit.version,
    status: exhibit.status,
    conditionNote: exhibit.conditionNote,
    note: exhibit.note,
    environment: exhibit.environment,
    attachments: exhibit.attachments.map((item) => ({ id: item.id, name: item.name })),
    discrepancies: discrepancies
      .filter((item) => item.exhibitId === exhibit.id)
      .map((item) => ({ id: item.id, title: item.title, severity: item.severity, resolved: item.resolved }))
  };
}

export function contentHashOf(exhibit: Exhibit, discrepancies: Discrepancy[]): string {
  return hashContent(signaturePayload(exhibit, discrepancies));
}

/** 签字是否仍绑定当前展品内容；环境、附件、差异项等签字后改动即失效 */
export function isSignatureValid(sig: Signature, exhibit: Exhibit, discrepancies: Discrepancy[]): boolean {
  if (sig.stage !== exhibit.stage || sig.baseVersion !== exhibit.version) return false;
  return sig.contentHash === contentHashOf(exhibit, discrepancies);
}

export function validSignatures(exhibit: Exhibit, signatures: Signature[], discrepancies: Discrepancy[], stage: Stage = exhibit.stage): Signature[] {
  return signatures.filter((sig) => sig.exhibitId === exhibit.id && sig.stage === stage && isSignatureValid(sig, exhibit, discrepancies));
}

export function hasRoleSignature(exhibit: Exhibit, signatures: Signature[], discrepancies: Discrepancy[], role: Role, stage: Stage = exhibit.stage): boolean {
  return validSignatures(exhibit, signatures, discrepancies, stage).some((sig) => sig.role === role);
}

export type GateCode = 'unresolvedDiscrepancy' | 'missingKeeper' | 'missingLender' | 'invalidSignature' | 'fieldConflict' | 'alreadyReturned' | 'ok';

export interface GateResult { ok: boolean; code: GateCode; message: string; }

/** 推进/归还门禁：差异未解决、签字版本对不上、存在未确认字段冲突一律挡住 */
export function evaluateGate(exhibit: Exhibit, signatures: Signature[], discrepancies: Discrepancy[], conflicts: Conflict[]): GateResult {
  if (exhibit.returnedAt) return { ok: false, code: 'alreadyReturned', message: '该展品已完成归还' };
  if (discrepancies.some((item) => item.exhibitId === exhibit.id && !item.resolved)) {
    return { ok: false, code: 'unresolvedDiscrepancy', message: '存在未解决差异项，需先确认解决' };
  }
  const pendingConflict = conflicts.some((item) => item.exhibitId === exhibit.id && item.resolvedOpId === null);
  if (pendingConflict) return { ok: false, code: 'fieldConflict', message: '同一字段存在两版离线改动，需先确认保留哪一版' };
  const stageSigs = signatures.filter((sig) => sig.exhibitId === exhibit.id && sig.stage === exhibit.stage);
  if (!stageSigs.some((sig) => sig.role === '保管员')) return { ok: false, code: 'missingKeeper', message: '缺少保管员签字' };
  if (!stageSigs.some((sig) => sig.role === '借展方')) return { ok: false, code: 'missingLender', message: '缺少借展方签字' };
  const invalid = stageSigs.find((sig) => !isSignatureValid(sig, exhibit, discrepancies));
  if (invalid) {
    return { ok: false, code: 'invalidSignature', message: `${invalid.role}签字绑定的是旧内容（版本 ${invalid.baseVersion}），内容已变更需重新签字` };
  }
  return { ok: true, code: 'ok', message: '可以推进' };
}

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
