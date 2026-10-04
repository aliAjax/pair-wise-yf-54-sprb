<script setup lang="ts">
import { useExhibitionStore } from '../stores/exhibition';
import { FIELD_LABELS, type FieldName, formatTime } from '../services/offline';
import { shortId } from '../services/merge';

const store = useExhibitionStore();

function exhibitName(id: string) {
  const item = store.exhibits.find((entry) => entry.id === id);
  return item ? `${item.code} ${item.name}` : id;
}
function deviceLabel(id: string) {
  return store.devices[id]?.label ?? (id === 'server' ? '已提交版本' : id);
}
</script>

<template>
  <div>
    <v-alert v-if="!store.pendingConflicts.length" type="success" variant="tonal" icon="mdi-source-merge">
      当前没有待确认的字段冲突。两边离线改到不同字段时会自动按字段合并；同一字段各改一版才会留两版在这里。
    </v-alert>

    <v-card v-for="conflict of store.conflicts" :key="conflict.id" class="mb-3" :color="conflict.resolvedOpId ? 'green-lighten-5' : 'red-lighten-5'">
      <v-card-text>
        <div class="d-flex align-center flex-wrap ga-2">
          <v-chip size="small" :color="conflict.resolvedOpId ? 'green' : 'red'" variant="tonal">
            {{ conflict.resolvedOpId ? '已确认' : '待确认' }}
          </v-chip>
          <span class="text-subtitle-2">{{ exhibitName(conflict.exhibitId) }}</span>
          <span>字段「{{ FIELD_LABELS[conflict.field as FieldName] }}」</span>
          <span class="text-caption text-grey">基线值：{{ conflict.baseValue }}</span>
          <v-spacer />
          <span class="text-caption text-grey">冲突 {{ shortId(conflict.id) }}</span>
        </div>

        <v-row dense class="mt-2">
          <v-col v-for="version of conflict.versions" :key="version.opId" cols="12" md="6">
            <v-card variant="tonal" class="pa-3">
              <div class="d-flex align-center ga-2">
                <v-icon color="deep-purple">mdi-tablet-cellphone</v-icon>
                <b>{{ deviceLabel(version.deviceId) }}</b>
                <span class="text-caption text-grey">{{ formatTime(version.at) }} · op {{ shortId(version.opId) }}</span>
              </div>
              <div class="text-h6 mt-1">{{ version.value }}</div>
              <v-btn v-if="!conflict.resolvedOpId" size="small" color="deep-purple" variant="flat"
                @click="store.resolveConflict(conflict.id, version.opId)">保留这一版</v-btn>
              <v-chip v-else-if="conflict.resolvedOpId === version.opId" size="small" color="green" variant="flat" class="mt-1">已采用</v-chip>
              <v-chip v-else size="small" variant="text" class="mt-1">已废弃</v-chip>
            </v-card>
          </v-col>
        </v-row>
        <div v-if="conflict.resolvedAt" class="text-caption text-green-darken-2 mt-1">
          已于 {{ formatTime(conflict.resolvedAt) }} 确认，相关批次的推进/归还操作已自动按离线编号重试。
        </div>
      </v-card-text>
    </v-card>
  </div>
</template>
