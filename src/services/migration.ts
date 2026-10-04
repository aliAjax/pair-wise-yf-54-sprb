// 旧版本（v1：只有 signed 角色数组）升级到 v2：版本、签字哈希、来源记录
import {
  type Discrepancy, type Exhibit, type FieldName, type Role, type Signature, type SourceRecord,
  type Stage, contentHashOf, uid
} from './offline';

export interface V2Data {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  signatures: Signature[];
  sources: SourceRecord[];
}

const EMPTY_REVISIONS = (): Record<FieldName, undefined> => ({
  status: undefined, conditionNote: undefined, temperature: undefined, humidity: undefined,
  light: undefined, hall: undefined, note: undefined
});

/**
 * 按现有签字和阶段升级旧数据：
 * - 展品补 version=1 与新字段，作为合并基线；
 * - signed 数组里的角色在「当前阶段」补一条 migration 签字，哈希按当时内容补算；
 * - 每件展品补一条来源记录。
 */
export function migrateV1Data(raw: { exhibits?: unknown; discrepancies?: unknown }, now: number): V2Data {
  const oldExhibits = Array.isArray(raw.exhibits) ? (raw.exhibits as Array<Record<string, unknown>>) : [];
  const oldDisc = Array.isArray(raw.discrepancies) ? (raw.discrepancies as Discrepancy[]) : [];
  const discrepancies: Discrepancy[] = oldDisc.map((item) => ({ ...item }));

  const exhibits: Exhibit[] = oldExhibits.map((old) => ({
    id: String(old.id ?? uid('ex')),
    code: String(old.code ?? ''),
    name: String(old.name ?? ''),
    lender: String(old.lender ?? ''),
    hall: String(old.hall ?? ''),
    stage: (['arrival', 'install', 'return'].includes(old.stage as string) ? old.stage : 'arrival') as Stage,
    version: 1,
    status: (['pending', 'passed', 'issue'].includes(old.status as string) ? old.status : 'pending') as Exhibit['status'],
    conditionNote: typeof old.conditionNote === 'string' ? old.conditionNote : '',
    note: typeof old.note === 'string' ? old.note : '',
    environment: {
      temperature: Number((old.environment as { temperature?: number })?.temperature ?? 20),
      humidity: Number((old.environment as { humidity?: number })?.humidity ?? 50),
      light: Number((old.environment as { light?: number })?.light ?? 150)
    },
    attachments: Array.isArray(old.attachments) ? old.attachments as Exhibit['attachments'] : [],
    returnedAt: typeof old.returnedAt === 'number' ? old.returnedAt : null,
    fieldRevisions: EMPTY_REVISIONS()
  }));

  const signatures: Signature[] = [];
  const sources: SourceRecord[] = [];
  const stageText = (stage: Stage) => stage === 'arrival' ? '到场点交' : stage === 'install' ? '布展核验' : '闭展归还';

  for (const exhibit of exhibits) {
    const old = oldExhibits.find((item) => String(item.id) === exhibit.id);
    const roles = Array.isArray(old?.signed) ? (old!.signed as unknown[]).filter((r): r is Role => r === '保管员' || r === '借展方') : [];
    for (const role of roles) {
      signatures.push({
        exhibitId: exhibit.id,
        stage: exhibit.stage,
        role,
        deviceId: 'migration',
        at: now,
        baseVersion: exhibit.version,
        contentHash: contentHashOf(exhibit, discrepancies),
        source: 'migration'
      });
    }
    sources.push({
      id: uid('src'),
      exhibitId: exhibit.id,
      at: now,
      kind: 'migrated',
      detail: `旧版本数据升级：当前阶段${stageText(exhibit.stage)}，补录${roles.length ? roles.join('、') + '的' : ''}既有签字来源，基线版本 v${exhibit.version}`
    });
  }
  return { exhibits, discrepancies, signatures, sources };
}
