<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { useExhibitionStore, stageLabel, type Exhibit, type Role, type OfflineBatch } from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy'>('checkin');
const dialog = ref(false);
const selected = ref<Exhibit | null>(null);
const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const apiLabel = computed(() => String(api.defaults.baseURL));

const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });

const current = computed(() => (selected.value ? store.displayExhibit(selected.value.id) : null));
const pendingChanges = computed(() => (selected.value ? store.pendingChangesFor(selected.value.id) : []));
const gateReasons = computed(() => (selected.value ? store.gateReasons(selected.value.id) : []));

function signInfo(exhibit: Exhibit, role: Role) {
  const signature = exhibit.signed.find((item) => item.role === role);
  return { signature, valid: signature ? store.signatureValid(exhibit, signature) : false };
}

function doSign(role: Role) {
  if (!selected.value) return;
  // 保管员用本机设备，借展方用其本人设备号；两方同设备签字会被判定为越权代签。
  const deviceId = role === '借展方' ? store.borrowerDeviceId : store.deviceId;
  store.sign(selected.value.id, role, deviceId);
}

function doAdvance() {
  if (!selected.value) return;
  const result = store.advance(selected.value.id);
  if (!result.ok) gateMsg.value = result.reasons.join('；');
  else gateMsg.value = '';
}
function doReturn() {
  if (!selected.value) return;
  const result = store.completeReturn(selected.value.id);
  if (!result.ok) gateMsg.value = result.reasons.join('；');
  else gateMsg.value = '';
}
const gateMsg = ref('');

function patchField(field: string, value: unknown) {
  if (!selected.value) return;
  store.editExhibit(selected.value.id, { [field]: value });
}
function patchEnv(field: 'temperature' | 'humidity' | 'light', raw: string) {
  const value = Number(raw);
  if (Number.isNaN(value)) return;
  patchField(`environment.${field}`, value);
}
const newAttachment = ref('');
function addAttachment() {
  if (!selected.value || !newAttachment.value.trim()) return;
  const exhibit = store.exhibits.find((item) => item.id === selected.value!.id);
  if (!exhibit) return;
  store.editExhibit(selected.value.id, { attachments: [...exhibit.attachments, newAttachment.value.trim()] });
  newAttachment.value = '';
}
function removeAttachment(name: string) {
  const sel = selected.value;
  if (!sel) return;
  const exhibit = store.exhibits.find((item) => item.id === sel.id);
  if (!exhibit) return;
  store.editExhibit(sel.id, { attachments: exhibit.attachments.filter((item) => item !== name) });
}

const simField = ref('environment.humidity');
const simValue = ref('55');
function simulateServer() {
  if (!selected.value) return;
  const value = simField.value.startsWith('environment.') ? Number(simValue.value) : simValue.value;
  store.simulateServerChange(selected.value.id, simField.value, value);
}

function fieldLabel(field: string): string {
  return ({ hall: '展厅/柜位', status: '条件状态', attachments: '附件清单', 'environment.temperature': '温度', 'environment.humidity': '湿度', 'environment.light': '照度' } as Record<string, string>)[field] ?? field;
}
function fmtTime(ts: number): string {
  if (!ts) return '升级补录';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const conflictBatches = computed(() => store.batches.filter((batch) => batch.status === 'conflict'));
const currentConflictBatches = computed(() =>
  selected.value ? store.batches.filter((batch) => batch.exhibitId === selected.value!.id && batch.status === 'conflict') : []
);
const failedBatches = computed(() => store.batches.filter((batch) => batch.status === 'failed'));
const pendingBatches = computed(() => store.batches.filter((batch) => batch.status === 'pending'));

function syncAll() {
  store.syncQueue();
}
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-chip class="mr-2" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线续作' }}</v-chip>
      <v-chip class="mr-3" variant="outlined" theme="dark">设备 {{ store.deviceId }}</v-chip>
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online || store.queuedCount" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          网络不稳时改动按字段留存在本地：每件记录改动字段、设备号与基线版本，回网后按字段合并，不同字段都留下，同一字段两版待确认。
          当前 {{ store.queuedCount }} 个离线批次（待合并 {{ pendingBatches.length }} · 冲突 {{ conflictBatches.length }} · 失败 {{ failedBatches.length }}）。接口地址 {{ apiLabel }}
          <template #append><v-btn v-if="online" variant="text" @click="syncAll">确认同步</v-btn></template>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">本地待同步</div><div class="metric">{{ store.queuedCount }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card v-if="store.batches.length" class="mb-5">
          <v-card-title class="text-subtitle-1">离线批次</v-card-title>
          <v-card-text>
            <v-list density="compact">
              <v-list-item v-for="batch in store.batches" :key="batch.id" class="batch-row">
                <v-list-item-title>
                  <v-chip size="small" class="mr-2" :color="batch.status === 'merged' ? 'green' : batch.status === 'conflict' ? 'red' : batch.status === 'failed' ? 'red-darken-3' : 'grey'">{{ batch.status }}</v-chip>
                  <b>{{ batch.id }}</b>
                  <span class="text-grey ml-2">设备 {{ batch.deviceId }} · 基线 v{{ batch.baseVersion }} · {{ stageLabel(store.exhibits.find((e) => e.id === batch.exhibitId)?.stage ?? 'arrival') }}</span>
                </v-list-item-title>
                <v-list-item-subtitle>
                  改动字段：<span v-for="c in batch.changes" :key="c.field" class="mr-2">{{ fieldLabel(c.field) }}({{ JSON.stringify(c.before) }} → {{ JSON.stringify(c.after) }})</span>
                  <span v-if="batch.error" class="text-red">· {{ batch.error }}</span>
                </v-list-item-subtitle>
                <template #append>
                  <v-btn v-if="batch.status === 'failed'" size="small" color="red" variant="text" @click="store.retryBatch(batch.id)">按编号重试</v-btn>
                  <v-btn v-if="batch.status === 'conflict'" size="small" color="deep-purple" variant="text" @click="selected = store.exhibits.find((e) => e.id === batch.exhibitId) ?? null">去确认两版</v-btn>
                </template>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab><v-tab value="environment">{{ $t('environment') }}</v-tab><v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>
                      {{ item.name }} · {{ item.code }}
                      <v-chip size="x-small" class="ml-1" variant="outlined">v{{ item.version }}</v-chip>
                      <v-chip v-if="store.pendingChangesFor(item.id).length" size="x-small" color="orange" class="ml-1">{{ store.pendingChangesFor(item.id).length }} 项离线改动</v-chip>
                      <v-chip v-if="store.batches.some((b) => b.exhibitId === item.id && b.status === 'conflict')" size="x-small" color="red" class="ml-1">冲突待确认</v-chip>
                      <v-chip v-if="item.returned" size="x-small" color="green" class="ml-1">已归还</v-chip>
                    </v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · {{ stageLabel(item.stage) }}</v-list-item-subtitle>
                    <template #append>
                      <v-chip size="small" :color="item.status === 'issue' ? 'red' : item.status === 'passed' ? 'green' : 'grey'">{{ item.status }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>
            <v-window-item value="environment">
              <v-table>
                <thead><tr><th>展品</th><th>温度</th><th>湿度</th><th>照度</th><th>条件</th></tr></thead>
                <tbody>
                  <tr v-for="item in store.exhibits" :key="item.id">
                    <td>{{ item.code }}<v-chip v-if="store.pendingChangesFor(item.id).length" size="x-small" color="orange" class="ml-1">离线</v-chip></td>
                    <td><v-text-field size="small" variant="underlined" density="compact" type="number" :model-value="store.displayExhibit(item.id)?.environment.temperature" @update:model-value="(v: string) => patchEnv('temperature', v)" /></td>
                    <td><v-text-field size="small" variant="underlined" density="compact" type="number" :model-value="store.displayExhibit(item.id)?.environment.humidity" @update:model-value="(v: string) => patchEnv('humidity', v)" /></td>
                    <td><v-text-field size="small" variant="underlined" density="compact" type="number" :model-value="store.displayExhibit(item.id)?.environment.light" @update:model-value="(v: string) => patchEnv('light', v)" /></td>
                    <td><v-btn size="small" color="green" variant="text" @click="store.setCondition(item.id, 'passed')">通过</v-btn><v-btn size="small" color="red" variant="text" @click="store.setCondition(item.id, 'issue')">异常</v-btn></td>
                  </tr>
                </tbody>
              </v-table>
            </v-window-item>
            <v-window-item value="discrepancy">
              <v-list><v-list-item v-for="item in store.discrepancies" :key="item.id"><v-list-item-title>{{ item.title }}</v-list-item-title><v-list-item-subtitle>展品 {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}</v-list-item-subtitle><template #append><v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template></v-list-item></v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="760" @update:model-value="selected = null">
          <v-card v-if="current" :title="`${current.code} · ${current.name} · v${current.version}`">
            <v-card-text>
              <v-alert v-if="current.source" type="info" variant="tonal" class="mb-3">来源记录：{{ current.source }}</v-alert>

              <v-alert v-if="pendingChanges.length" type="warning" variant="tonal" class="mb-3">
                有 {{ pendingChanges.length }} 项离线改动待合并：<span v-for="(c, i) in pendingChanges" :key="i" class="mr-2">{{ fieldLabel(c.field) }}→{{ JSON.stringify(c.after) }}</span>
                <br />合并后展品内容可能变化，已签字版会失效需重签。
              </v-alert>

              <template v-for="batch in currentConflictBatches" :key="batch.id">
                <v-alert type="error" variant="tonal" class="mb-3">
                  <div class="font-weight-bold">字段冲突待确认（离线编号 {{ batch.id }}）</div>
                  <div v-for="conflict in batch.conflicts" :key="conflict.field" class="mt-2">
                    {{ fieldLabel(conflict.field) }}：
                    <v-btn size="small" :color="conflict.resolution === 'local' ? 'green' : 'grey'" variant="tonal" class="mx-1" @click="store.resolveConflict(batch.id, conflict.field, 'local')">采用离线版 {{ JSON.stringify(conflict.localValue) }}</v-btn>
                    <v-btn size="small" :color="conflict.resolution === 'server' ? 'green' : 'grey'" variant="tonal" class="mx-1" @click="store.resolveConflict(batch.id, conflict.field, 'server')">采用服务端版 {{ JSON.stringify(conflict.serverValue) }}</v-btn>
                    <span v-if="conflict.resolution" class="text-green ml-2">已确认采用{{ conflict.resolution === 'local' ? '离线' : '服务端' }}版</span>
                  </div>
                </v-alert>
              </template>

              <v-timeline side="end" density="compact">
                <v-timeline-item dot-color="green">
                  <b>保管员点收</b>
                  <p>核对包装、封条和附件清单。签字绑定当时展品内容（v{{ current.version }}）。</p>
                  <template v-if="signInfo(current, '保管员').signature">
                    <v-chip size="small" :color="signInfo(current, '保管员').valid ? 'green' : 'red'" class="mr-2">{{ signInfo(current, '保管员').valid ? '签字有效' : '签字已失效' }}</v-chip>
                    <span class="text-grey text-caption">设备 {{ signInfo(current, '保管员').signature!.deviceId }} · {{ fmtTime(signInfo(current, '保管员').signature!.signedAt) }}</span>
                  </template>
                  <v-btn size="small" class="mt-1" @click="doSign('保管员')">{{ signInfo(current, '保管员').signature ? '重新签字' : '保管员签字' }}</v-btn>
                </v-timeline-item>
                <v-timeline-item dot-color="orange">
                  <b>借展方确认</b>
                  <p>确认差异项及后续责任。须由借展方本人设备（{{ store.borrowerDeviceId }}）签字，不得代签。</p>
                  <template v-if="signInfo(current, '借展方').signature">
                    <v-chip size="small" :color="signInfo(current, '借展方').valid ? 'green' : 'red'" class="mr-2">{{ signInfo(current, '借展方').valid ? '签字有效' : '签字已失效' }}</v-chip>
                    <span class="text-grey text-caption">设备 {{ signInfo(current, '借展方').signature!.deviceId }} · {{ fmtTime(signInfo(current, '借展方').signature!.signedAt) }}</span>
                  </template>
                  <v-btn size="small" class="mt-1" @click="doSign('借展方')">{{ signInfo(current, '借展方').signature ? '重新签字' : '借展方签字' }}</v-btn>
                </v-timeline-item>
              </v-timeline>

              <v-divider class="my-3" />
              <div class="text-subtitle-2 mb-2">离线字段编辑（回网后按字段合并）</div>
              <v-row dense>
                <v-col cols="6"><v-text-field size="small" label="展厅/柜位" :model-value="current.hall" @update:model-value="(v: string) => patchField('hall', v)" /></v-col>
                <v-col cols="6"><v-select size="small" label="条件状态" :model-value="current.status" :items="['pending', 'passed', 'issue']" @update:model-value="(v: string) => patchField('status', v)" /></v-col>
                <v-col cols="4"><v-text-field size="small" type="number" label="温度" :model-value="current.environment.temperature" @update:model-value="(v: string) => patchEnv('temperature', v)" /></v-col>
                <v-col cols="4"><v-text-field size="small" type="number" label="湿度" :model-value="current.environment.humidity" @update:model-value="(v: string) => patchEnv('humidity', v)" /></v-col>
                <v-col cols="4"><v-text-field size="small" type="number" label="照度" :model-value="current.environment.light" @update:model-value="(v: string) => patchEnv('light', v)" /></v-col>
              </v-row>
              <div class="text-caption text-grey mt-1">附件清单（签字绑定内容，改动后签字失效）：</div>
              <v-chip v-for="a in current.attachments" :key="a" size="small" class="mr-1 mt-1" closable @click:close="removeAttachment(a)">{{ a }}</v-chip>
              <v-text-field size="small" class="mt-2" placeholder="新增附件后回车" v-model="newAttachment" @keyup.enter="addAttachment" @click:append="addAttachment" append-inner-icon="mdi-plus" />

              <v-divider class="my-3" />
              <div class="text-subtitle-2 mb-2">模拟对端设备改动（演示回网字段合并）</div>
              <v-row dense>
                <v-col cols="5"><v-select size="small" label="字段" v-model="simField" :items="[{ title: '展厅/柜位', value: 'hall' }, { title: '温度', value: 'environment.temperature' }, { title: '湿度', value: 'environment.humidity' }, { title: '照度', value: 'environment.light' }]" /></v-col>
                <v-col cols="4"><v-text-field size="small" label="改为" v-model="simValue" /></v-col>
                <v-col cols="3"><v-btn size="small" color="deep-purple" variant="tonal" class="mt-1" @click="simulateServer">写入服务端</v-btn></v-col>
              </v-row>

              <v-divider class="my-3" />
              <v-alert v-if="gateMsg" type="error" variant="tonal" class="mb-2">门禁未通过：{{ gateMsg }}</v-alert>
              <v-alert v-else-if="gateReasons.length" type="warning" variant="tonal" class="mb-2">门禁未通过：{{ gateReasons.join('；') }}</v-alert>
              <v-btn color="deep-purple" class="mr-2" @click="doAdvance">推进到下一阶段</v-btn>
              <v-btn v-if="current.stage === 'return'" color="green" @click="doReturn" :disabled="current.returned">{{ current.returned ? '已归还' : '确认归还' }}</v-btn>
            </v-card-text>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
.batch-row { border-bottom: 1px solid #f0f0f0; }
</style>
