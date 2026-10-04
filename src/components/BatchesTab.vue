<script setup lang="ts">
import { useExhibitionStore } from '../stores/exhibition';
import { FIELD_LABELS, type FieldName, type OpType, formatTime, type OfflineOp } from '../services/offline';
import { shortId } from '../services/merge';

const store = useExhibitionStore();

const OP_LABEL: Record<OpType, string> = {
  edit: '字段改动',
  sign: '签字',
  addAttachment: '新增附件',
  removeAttachment: '删除附件',
  discrepancyAdd: '新增差异',
  discrepancyResolve: '解决差异',
  advance: '推进阶段',
  return: '归还确认',
  create: '登记展品'
};
const STATUS_COLOR: Record<string, string> = {
  queued: 'orange', applied: 'green', conflict: 'red', blocked: 'red-darken-2', superseded: 'grey', invalid: 'grey'
};
const STATUS_LABEL: Record<string, string> = {
  queued: '待回网', applied: '已落库', conflict: '字段冲突', blocked: '被门禁挡住', superseded: '已被取代', invalid: '失效'
};

function exhibitName(id: string) {
  if (id === '-') return '批次级';
  const item = store.exhibits.find((entry) => entry.id === id);
  return item ? `${item.code}` : id;
}
function opDetail(op: OfflineOp) {
  if (op.type === 'edit') return `${FIELD_LABELS[op.field as FieldName]} → ${op.value}`;
  if (op.type === 'sign') return `${op.role}签字`;
  if (op.type === 'addAttachment') return op.attachment?.name ?? '附件';
  if (op.type === 'removeAttachment') return `删除附件 ${op.attachmentId}`;
  if (op.type === 'discrepancyAdd') return op.discrepancy?.title ?? '差异';
  if (op.type === 'discrepancyResolve') return `解决差异 ${op.discrepancyId}`;
  return '';
}
</script>

<template>
  <div>
    <v-alert type="info" variant="tonal" icon="mdi-cloud-sync-outline" class="mb-3">
      合并失败的批次不会丢失：每条批次带离线编号，回网后按编号顺序回放；被挡住的推进/归还可在下方直接「按编号重试」。
      <template #append>
        <v-btn color="deep-purple" variant="tonal" :disabled="!store.openBatches.length" @click="store.mergeAll()">立即回网合并 ({{ store.openBatches.length }})</v-btn>
      </template>
    </v-alert>

    <v-card v-if="!store.batches.length" variant="tonal" class="pa-6 text-center text-grey">
      <v-icon size="36" color="grey-lighten-1">mdi-tray</v-icon>
      <div class="mt-2">还没有离线批次，先在离线状态下改动展品试试</div>
    </v-card>

    <v-expansion-panels v-for="batch in [...store.batches].reverse()" :key="batch.id" class="mb-2">
      <v-expansion-panel>
        <v-expansion-panel-title>
          <v-chip size="small" class="mr-3" :color="batch.status === 'merged' ? 'green' : batch.status === 'blocked' ? 'red' : 'orange'" variant="tonal">
            {{ batch.status === 'merged' ? '已合并' : batch.status === 'blocked' ? '合并受阻' : '本地待回网' }}
          </v-chip>
          <span class="font-weight-bold">{{ store.devices[batch.deviceId]?.label ?? batch.deviceId }}</span>
          <span class="ml-3 text-caption">编号 {{ batch.id }}</span>
          <v-spacer />
          <span class="text-caption text-grey mr-3">{{ batch.ops.length }} 条 · 开建于 {{ formatTime(batch.openedAt) }}</span>
          <v-btn v-if="batch.status === 'blocked'" size="small" color="deep-purple" variant="flat" @click.stop="store.retryBatch(batch.id)">按编号重试</v-btn>
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <v-list density="compact">
            <v-list-item v-for="op in batch.ops" :key="op.id" class="px-0">
              <template #prepend>
                <v-chip x-small :color="STATUS_COLOR[op.status]" variant="tonal">{{ STATUS_LABEL[op.status] }}</v-chip>
              </template>
              <v-list-item-title>
                {{ exhibitName(op.exhibitId) }} · {{ OP_LABEL[op.type] }}
                <span class="text-body-2 text-grey">{{ opDetail(op) }}</span>
              </v-list-item-title>
              <v-list-item-subtitle v-if="op.baseline" class="text-grey">
                基线值「{{ op.baseline.value }}」 · 设备 {{ shortId(op.deviceId) }} · {{ formatTime(op.at) }}
              </v-list-item-subtitle>
              <v-list-item-subtitle v-else class="text-grey">{{ shortId(op.deviceId) }} · {{ formatTime(op.at) }}</v-list-item-subtitle>
              <v-list-item-subtitle v-if="op.blockReason" class="text-red">{{ op.blockReason }}</v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </div>
</template>
