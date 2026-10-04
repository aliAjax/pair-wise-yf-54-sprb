<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useExhibitionStore } from '../stores/exhibition';
import {
  type Exhibit, type Signature, FIELD_LABELS, STAGE_LABELS, isSignatureValid
} from '../services/offline';
import { shortId } from '../services/merge';

const props = defineProps<{ modelValue: boolean; exhibitId: string | null }>();
const emit = defineEmits<{ 'update:modelValue': [boolean]; notice: [string, string] }>();
const store = useExhibitionStore();

const exhibit = computed<Exhibit | undefined>(() => store.view.exhibits.find((item) => item.id === props.exhibitId));
const canon = computed(() => store.exhibits.find((item) => item.id === props.exhibitId));
const viewSignatures = computed(() => exhibit.value ? store.view.signatures.filter((sig) => sig.exhibitId === exhibit.value!.id) : []);
const gate = computed(() => (exhibit.value ? store.gateFor(exhibit.value.id) : null));
const discrepancyList = computed(() => store.view.discrepancies.filter((item) => item.exhibitId === props.exhibitId));
const openBatch = computed(() => store.openBatch);

const draft = ref<Record<string, string>>({});
watch(exhibit, (item) => {
  if (!item) return;
  draft.value = {
    hall: item.hall,
    note: item.note,
    conditionNote: item.conditionNote,
    temperature: String(item.environment.temperature),
    humidity: String(item.environment.humidity),
    light: String(item.environment.light)
  };
}, { immediate: true });

const editedFields = computed(() => {
  if (!exhibit.value) return [];
  const map: Record<string, string> = {
    hall: exhibit.value.hall, note: exhibit.value.note, conditionNote: exhibit.value.conditionNote,
    temperature: String(exhibit.value.environment.temperature), humidity: String(exhibit.value.environment.humidity),
    light: String(exhibit.value.environment.light)
  };
  return Object.keys(draft.value).filter((field) => draft.value[field] !== map[field]) as Array<keyof typeof FIELD_LABELS>;
});

function saveField(field: keyof typeof FIELD_LABELS) {
  if (!exhibit.value) return;
  store.recordEdit(exhibit.value.id, field, draft.value[field]);
  emit('notice', 'success', `字段「${FIELD_LABELS[field]}」已记入离线批次，基线 v${canon.value?.version}`);
}
function saveAll() {
  if (!exhibit.value) return;
  for (const field of editedFields.value) saveField(field);
}
function setCondition(status: 'passed' | 'issue') {
  if (!exhibit.value) return;
  store.recordCondition(exhibit.value.id, status);
  emit('notice', 'success', `条件结论「${status === 'passed' ? '通过' : '异常'}」已记入批次`);
}
function sign(role: '保管员' | '借展方') {
  if (!exhibit.value) return;
  const result = store.recordSign(exhibit.value.id, role);
  emit('notice', result.ok ? 'success' : 'error', result.message);
}
function advance() {
  if (!exhibit.value) return;
  const result = store.recordAdvance(exhibit.value.id);
  emit('notice', result.ok ? 'success' : 'error', result.ok ? (result.merged ? '已推进到下一阶段' : '推进操作已入离线批次') : result.message);
}
function doReturn() {
  if (!exhibit.value) return;
  const result = store.recordReturn(exhibit.value.id);
  emit('notice', result.ok ? 'success' : 'error', result.ok ? (result.merged ? '归还确认已落库' : '归还确认已入离线批次') : result.message);
}

const attachmentName = ref('');
function addAttachment() {
  if (!exhibit.value || !attachmentName.value.trim()) return;
  store.recordAttachment(exhibit.value.id, attachmentName.value.trim());
  attachmentName.value = '';
}

const discrepancyTitle = ref('');
const discrepancySeverity = ref<'minor' | 'major'>('minor');
function addDiscrepancy() {
  if (!exhibit.value || !discrepancyTitle.value.trim()) return;
  store.addDiscrepancy(exhibit.value.id, discrepancyTitle.value.trim(), discrepancySeverity.value);
  discrepancyTitle.value = '';
  emit('notice', 'success', '差异项已记入批次');
}

function sigState(sig: Signature) {
  const ex = canon.value;
  if (!ex) return { valid: true, text: '' };
  const valid = isSignatureValid(sig, ex, store.discrepancies);
  return { valid, text: valid ? `有效 · 绑定 v${sig.baseVersion}` : `已失效 · 签字时 v${sig.baseVersion}，当前 v${ex.version}` };
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="860" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card v-if="exhibit">
      <v-card-title class="d-flex align-center ga-2 flex-wrap">
        <span>{{ exhibit.code }} · {{ exhibit.name }}</span>
        <v-chip size="small" color="deep-purple" variant="tonal">{{ STAGE_LABELS[exhibit.stage] }}</v-chip>
        <v-chip size="small" :color="exhibit.returnedAt ? 'green' : 'grey'" variant="tonal">
          {{ exhibit.returnedAt ? '已归还' : `内容版本 v${exhibit.version}` }}
        </v-chip>
        <v-spacer />
        <span class="text-caption text-grey">以 {{ store.currentDevice.label }} 视角查看</span>
      </v-card-title>

      <v-card-text>
        <v-alert v-if="openBatch" type="info" variant="tonal" density="compact" class="mb-3">
          当前改动在离线批次 <code>{{ shortId(openBatch.id) }}</code> 中，共 {{ openBatch.ops.length }} 条
          <span v-if="!store.online">，回网后自动按字段合并</span>
        </v-alert>

        <v-row dense>
          <v-col cols="12" md="6">
            <v-text-field v-model="draft.hall" label="展厅/柜位" density="compact" :hint="`基线值：${canon?.hall}`" persistent-hide-details="false">
              <template #append><v-btn icon="mdi-content-save-check-outline" :disabled="draft.hall === exhibit.hall" @click="saveField('hall')" /></template>
            </v-text-field>
          </v-col>
          <v-col cols="12" md="6">
            <v-text-field v-model="draft.conditionNote" label="条件说明" density="compact"
              :hint="`基线值：${canon?.conditionNote || '（空）'}`">
              <template #append><v-btn icon="mdi-content-save-check-outline" :disabled="draft.conditionNote === exhibit.conditionNote" @click="saveField('conditionNote')" /></template>
            </v-text-field>
          </v-col>
          <v-col cols="4">
            <v-text-field v-model="draft.temperature" label="温度 ℃" type="number" density="compact"
              :hint="`基线 ${canon?.environment.temperature}`">
              <template #append><v-btn icon="mdi-content-save-check-outline" :disabled="draft.temperature === String(exhibit.environment.temperature)" @click="saveField('temperature')" /></template>
            </v-text-field>
          </v-col>
          <v-col cols="4">
            <v-text-field v-model="draft.humidity" label="湿度 %" type="number" density="compact"
              :hint="`基线 ${canon?.environment.humidity}`">
              <template #append><v-btn icon="mdi-content-save-check-outline" :disabled="draft.humidity === String(exhibit.environment.humidity)" @click="saveField('humidity')" /></template>
            </v-text-field>
          </v-col>
          <v-col cols="4">
            <v-text-field v-model="draft.light" label="照度 lux" type="number" density="compact"
              :hint="`基线 ${canon?.environment.light}`">
              <template #append><v-btn icon="mdi-content-save-check-outline" :disabled="draft.light === String(exhibit.environment.light)" @click="saveField('light')" /></template>
            </v-text-field>
          </v-col>
          <v-col cols="12">
            <v-textarea v-model="draft.note" label="处理意见" rows="2" density="compact"
              :hint="`基线值：${canon?.note || '（空）'}`">
              <template #append><v-btn icon="mdi-content-save-check-outline" :disabled="draft.note === exhibit.note" @click="saveField('note')" /></template>
            </v-textarea>
          </v-col>
          <v-col cols="12" v-if="editedFields.length">
            <v-alert type="warning" density="compact" variant="text" class="py-0">
              还有 {{ editedFields.length }} 个字段改动未入队
              <v-btn size="small" variant="tonal" class="ml-2" @click="saveAll">全部写入批次</v-btn>
            </v-alert>
          </v-col>
        </v-row>

        <v-divider class="my-3" />
        <div class="d-flex align-center ga-2 flex-wrap mb-2">
          <span class="text-subtitle-2">条件结论</span>
          <v-btn size="small" :color="exhibit.status === 'passed' ? 'green' : undefined" variant="tonal" @click="setCondition('passed')">通过</v-btn>
          <v-btn size="small" :color="exhibit.status === 'issue' ? 'red' : undefined" variant="tonal" @click="setCondition('issue')">异常</v-btn>
          <v-spacer />
          <span class="text-caption text-grey">当前：{{ exhibit.status }}</span>
        </div>

        <v-divider class="my-3" />
        <div class="text-subtitle-2 mb-1">附件（签字后增减即令签字失效）</div>
        <v-chip v-for="att in exhibit.attachments" :key="att.id" closable size="small" color="blue-lighten-4" class="ma-1"
          @click:close="store.removeAttachment(exhibit.id, att.id)">{{ att.name }}</v-chip>
        <v-text-field v-model="attachmentName" density="compact" placeholder="附件名称，如 点交照片-正面.jpg" hide-details class="d-inline-block mt-1" style="max-width: 320px">
          <template #append><v-btn icon="mdi-paperclip-plus" @click="addAttachment" /></template>
        </v-text-field>

        <v-divider class="my-3" />
        <div class="text-subtitle-2 mb-1">差异项</div>
        <v-list density="compact" class="bg-transparent">
          <v-list-item v-for="d in discrepancyList" :key="d.id" class="px-0">
            <v-list-item-title>{{ d.title }}
              <v-chip size="x-small" :color="d.severity === 'major' ? 'red' : 'amber'" variant="tonal" class="ml-2">
                {{ d.severity === 'major' ? '重大' : '轻微' }}
              </v-chip>
            </v-list-item-title>
            <template #append>
              <v-btn size="small" :disabled="d.resolved" color="green" variant="tonal" @click="store.resolveDiscrepancy(d.id)">
                {{ d.resolved ? '已解决' : '确认解决' }}
              </v-btn>
            </template>
          </v-list-item>
        </v-list>
        <div class="d-flex ga-2">
          <v-select v-model="discrepancySeverity" :items="[{ title: '轻微', value: 'minor' }, { title: '重大', value: 'major' }]" density="compact" hide-details style="max-width: 120px" />
          <v-text-field v-model="discrepancyTitle" density="compact" placeholder="新增差异描述" hide-details>
            <template #append><v-btn icon="mdi-alert-circle-plus-outline" @click="addDiscrepancy" /></template>
          </v-text-field>
        </div>

        <v-divider class="my-3" />
        <div class="text-subtitle-2 mb-2">签字（绑定当时展品内容，内容变动即失效）</div>
        <v-list density="compact">
          <v-list-item v-for="sig in viewSignatures" :key="`${sig.stage}-${sig.role}-${sig.contentHash}`" class="px-0">
            <template #prepend><v-icon :color="sigState(sig).valid ? 'green' : 'red'">{{ sigState(sig).valid ? 'mdi-shield-check-outline' : 'mdi-shield-alert-outline' }}</v-icon></template>
            <v-list-item-title>{{ STAGE_LABELS[sig.stage] }} · {{ sig.role }}
              <span class="text-caption text-grey ml-2">{{ sig.source === 'migration' ? '旧数据迁移' : sig.deviceId === store.currentDeviceId ? '本机签字' : store.devices[sig.deviceId]?.label ?? sig.deviceId }}</span>
            </v-list-item-title>
            <v-list-item-subtitle>{{ sigState(sig).text }} · hash {{ sig.contentHash }}</v-list-item-subtitle>
          </v-list-item>
        </v-list>
        <div class="d-flex ga-2 flex-wrap">
          <v-btn size="small" color="brown-lighten-1" variant="tonal" prepend-icon="mdi-account-check-outline"
            :disabled="store.currentDevice.role !== '保管员'" @click="sign('保管员')">保管员签字</v-btn>
          <v-btn size="small" color="indigo-lighten-2" variant="tonal" prepend-icon="mdi-account-check-outline"
            :disabled="store.currentDevice.role !== '借展方'" @click="sign('借展方')">借展方签字</v-btn>
          <span v-if="store.currentDevice.role === '借展方'" class="text-caption text-red align-self-center">借展方设备不可替保管员签字</span>
        </div>

        <v-divider class="my-3" />
        <v-alert :type="gate?.ok ? 'success' : 'error'" variant="tonal" density="compact" class="mb-2">
          推进门禁：{{ gate?.message }}
        </v-alert>
        <div class="d-flex ga-2 flex-wrap">
          <v-btn color="deep-purple" prepend-icon="mdi-arrow-right-circle-outline" :disabled="!gate?.ok" @click="advance">
            推进到{{ exhibit.stage === 'arrival' ? '布展核验' : '闭展归还' }}
          </v-btn>
          <v-btn color="green" prepend-icon="mdi-package-check" variant="tonal"
            :disabled="!gate?.ok || exhibit.stage !== 'return' || Boolean(exhibit.returnedAt)" @click="doReturn">
            闭展归还确认
          </v-btn>
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>
