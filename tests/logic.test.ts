import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setActivePinia, createPinia } from 'pinia';
import { useExhibitionStore, contentHash, STORAGE_KEY } from '../src/stores/exhibition';

// 内存版 localStorage
const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => memory.delete(key),
  clear: () => memory.clear(),
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  length: memory.size
} as Storage;

function freshStore() {
  memory.clear();
  setActivePinia(createPinia());
  return useExhibitionStore();
}

test('离线改动：记录字段、设备号、基线版本', () => {
  const store = freshStore();
  const before = store.exhibits.find((e) => e.id === 'ex-1')!;
  assert.equal(before.hall, 'A2 温湿展柜');
  store.editExhibit('ex-1', { hall: '新展厅' });
  assert.equal(store.batches.length, 1);
  const batch = store.batches[0];
  assert.equal(batch.deviceId, store.deviceId);
  assert.equal(batch.baseVersion, 1);
  assert.deepEqual(batch.changes, [{ field: 'hall', before: 'A2 温湿展柜', after: '新展厅' }]);
  assert.equal(batch.status, 'pending');
  // 值不变时不生成批次
  store.editExhibit('ex-1', { hall: '新展厅' });
  assert.equal(store.batches.length, 1);
});

test('回网合并：两边改不同字段，两版都留下', () => {
  const store = freshStore();
  const ex = store.exhibits.find((e) => e.id === 'ex-11')!;
  assert.equal(ex.hall, 'B1 开放展区');
  assert.equal(ex.environment.humidity, 50);
  store.editExhibit('ex-11', { hall: '离线改的展厅' });
  store.simulateServerChange('ex-11', 'environment.humidity', 99);
  const result = store.syncQueue();
  assert.equal(result.merged, 1);
  assert.equal(result.conflict, 0);
  assert.equal(ex.hall, '离线改的展厅');    // 离线字段写入
  assert.equal(ex.environment.humidity, 99); // 服务端字段保留
});

test('回网合并：同一字段两边都改，留两版待确认', () => {
  const store = freshStore();
  const ex = store.exhibits.find((e) => e.id === 'ex-12')!;
  assert.equal(ex.hall, 'B1 开放展区');
  store.editExhibit('ex-12', { hall: '离线版展厅' });
  store.simulateServerChange('ex-12', 'hall', '服务端版展厅');
  const result = store.syncQueue();
  assert.equal(result.conflict, 1);
  const batch = store.batches[0];
  assert.equal(batch.status, 'conflict');
  assert.equal(batch.conflicts!.length, 1);
  const conflict = batch.conflicts![0];
  assert.equal(conflict.field, 'hall');
  assert.equal(conflict.baseValue, 'B1 开放展区');
  assert.equal(conflict.localValue, '离线版展厅');
  assert.equal(conflict.serverValue, '服务端版展厅');
  // 确认前服务端现值保留
  assert.equal(ex.hall, '服务端版展厅');
  // 确认采用离线版
  store.resolveConflict(batch.id, 'hall', 'local');
  assert.equal(ex.hall, '离线版展厅');
  assert.equal(batch.status, 'merged');
});

test('合并失败：批次不丢，按离线编号重试成功', () => {
  const store = freshStore();
  store.batches.push({
    id: 'off-fail-1',
    deviceId: store.deviceId,
    exhibitId: 'ex-gone',
    baseVersion: 1,
    changes: [{ field: 'hall', before: 'x', after: 'y' }],
    createdAt: 0,
    status: 'pending'
  });
  const result = store.syncQueue();
  assert.equal(result.failed, 1);
  const batch = store.batches.find((b) => b.id === 'off-fail-1')!;
  assert.equal(batch.status, 'failed');
  assert.ok(batch.error);
  // 补建展品后按编号重试
  store.exhibits.push({
    id: 'ex-gone', code: 'GX', name: '临时展品', lender: 'x', hall: 'x',
    stage: 'arrival', status: 'pending', signed: [],
    environment: { temperature: 20, humidity: 50, light: 150 }, attachments: [], version: 1
  });
  store.retryBatch('off-fail-1');
  assert.equal(batch.status, 'merged');
  assert.equal(store.exhibits.find((e) => e.id === 'ex-gone')!.hall, 'y');
});

test('签字绑定：内容变更后签字失效，重签后恢复', () => {
  const store = freshStore();
  const ex = store.exhibits.find((e) => e.id === 'ex-13')!;
  store.sign('ex-13', '保管员');
  store.sign('ex-13', '借展方');
  const keeper = ex.signed.find((s) => s.role === '保管员')!;
  const borrower = ex.signed.find((s) => s.role === '借展方')!;
  assert.equal(store.signatureValid(ex, keeper), true);
  assert.equal(store.signatureValid(ex, borrower), true);
  // 签字后改动环境（对端写入）
  store.simulateServerChange('ex-13', 'environment.light', 999);
  assert.equal(ex.version, 2);
  assert.equal(store.signatureValid(ex, keeper), false);
  assert.equal(store.signatureValid(ex, borrower), false);
  assert.ok(store.gateReasons('ex-13').some((r) => r.includes('签字已失效')));
  // 重新签字
  store.sign('ex-13', '保管员');
  store.sign('ex-13', '借展方');
  assert.equal(store.signatureValid(ex, ex.signed.find((s) => s.role === '保管员')!), true);
});

test('门禁：未解决差异阻断，解决后签字失效需重签，再签可推进', () => {
  const store = freshStore();
  const ex = store.exhibits.find((e) => e.id === 'ex-5')!;
  assert.equal(ex.stage, 'arrival');
  // 差异 d1 未解决
  assert.ok(store.gateReasons('ex-5').some((r) => r.includes('未解决的差异项')));
  assert.equal(store.advance('ex-5').ok, false);
  // 解决差异 → 版本递增 → 已有签字失效
  store.resolveDiscrepancy('d1');
  assert.equal(ex.version, 2);
  assert.ok(store.gateReasons('ex-5').some((r) => r.includes('签字已失效')));
  assert.equal(store.advance('ex-5').ok, false);
  // 重签后可推进（借展方用其本人设备号）
  store.sign('ex-5', '保管员');
  store.sign('ex-5', '借展方', store.borrowerDeviceId);
  const result = store.advance('ex-5');
  assert.equal(result.ok, true);
  assert.equal(ex.stage, 'install');
});

test('门禁：借展方同设备替保管员签字被判定越权，阻断推进', () => {
  const store = freshStore();
  // 同一台设备签两方
  store.sign('ex-15', '保管员');
  store.sign('ex-15', '借展方');
  const reasons = store.gateReasons('ex-15');
  assert.ok(reasons.some((r) => r.includes('越权')));
  assert.equal(store.advance('ex-15').ok, false);
});

test('门禁：有未合并离线批次时阻断推进', () => {
  const store = freshStore();
  store.sign('ex-16', '保管员');
  store.sign('ex-16', '借展方');
  store.editExhibit('ex-16', { hall: '未合并展厅' });
  assert.ok(store.gateReasons('ex-16').some((r) => r.includes('未合并的离线批次')));
  assert.equal(store.advance('ex-16').ok, false);
});

test('归还：门禁通过可确认归还，未解决差异则阻断', () => {
  const store = freshStore();
  const ex = store.exhibits.find((e) => e.id === 'ex-19')!;
  assert.equal(ex.stage, 'return');
  store.sign('ex-19', '保管员');
  store.sign('ex-19', '借展方', store.borrowerDeviceId);
  assert.equal(store.completeReturn('ex-19').ok, true);
  assert.equal(ex.returned, true);
  // 有未解决差异时归还被挡
  const store2 = freshStore();
  store2.sign('ex-5', '保管员');
  store2.sign('ex-5', '借展方', store2.borrowerDeviceId);
  assert.equal(store2.completeReturn('ex-5').ok, false);
});

test('升级兼容：旧 string[] 签字补来源记录，内容哈希可校验', () => {
  memory.clear();
  memory.set(STORAGE_KEY, JSON.stringify({
    exhibits: [{
      id: 'ex-old', code: 'O1', name: '旧展品', lender: '旧方', hall: '旧厅',
      stage: 'arrival', status: 'pending',
      signed: ['保管员', '借展方'],
      environment: { temperature: 20, humidity: 50, light: 150 }
    }],
    discrepancies: []
  }));
  setActivePinia(createPinia());
  const store = useExhibitionStore();
  const ex = store.exhibits[0];
  assert.equal(ex.version, 1);
  assert.deepEqual(ex.attachments, []);
  assert.ok(Array.isArray(ex.signed));
  assert.equal(ex.signed.length, 2);
  assert.equal(ex.signed[0].role, '保管员');
  assert.equal(ex.signed[0].deviceId, 'legacy-keeper');
  assert.equal(ex.signed[1].role, '借展方');
  assert.equal(ex.signed[1].deviceId, 'legacy-borrower');
  assert.ok(ex.source!.includes('升级补录'));
  assert.ok(ex.source!.includes('保管员'));
  assert.ok(ex.source!.includes('借展方'));
  assert.ok(ex.source!.includes('到场点交'));
  assert.deepEqual(store.batches, []);
  assert.match(store.deviceId, /^device-/);
  // 补录的签字与当前内容哈希一致
  assert.equal(store.signatureValid(ex, ex.signed[0]), true);
  assert.equal(store.signatureValid(ex, ex.signed[1]), true);
  // 哈希函数对环境变更敏感
  const h1 = contentHash(ex, []);
  ex.environment.light = 300;
  const h2 = contentHash(ex, []);
  assert.notEqual(h1, h2);
});
