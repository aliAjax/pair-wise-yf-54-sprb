<script setup lang="ts">
import { useExhibitionStore } from '../stores/exhibition';
import { formatTime } from '../services/offline';

const store = useExhibitionStore();

const KIND_ICON: Record<string, string> = {
  created: 'mdi-plus-circle-outline',
  migrated: 'mdi-database-sync-outline',
  merge: 'mdi-source-merge',
  resolve: 'mdi-hand-back-right-outline',
  returned: 'mdi-package-check',
  advanced: 'mdi-arrow-right-circle-outline'
};
const KIND_COLOR: Record<string, string> = {
  created: 'blue', migrated: 'purple', merge: 'deep-purple', resolve: 'amber', returned: 'green', advanced: 'teal'
};
</script>

<template>
  <v-card>
    <v-card-text>
      <div class="text-body-2 text-grey mb-3">
        每条展品的建档、离线合并、冲突确认、推进与归还都会留下来源记录；旧版本升级时会按现有签字和阶段补一条迁移来源。
      </div>
      <v-timeline side="start" density="compact">
        <v-timeline-item v-for="src in [...store.sources].reverse()" :key="src.id"
          :dot-color="KIND_COLOR[src.kind]" :icon="KIND_ICON[src.kind]" size="small">
          <div class="text-caption text-grey">{{ formatTime(src.at) }} · {{ src.exhibitId === '-' ? '批次级' : src.exhibitId }}</div>
          <div>{{ src.detail }}</div>
        </v-timeline-item>
      </v-timeline>
      <v-alert v-if="!store.sources.length" type="info" variant="text" icon="mdi-information-outline">暂无来源记录。</v-alert>
    </v-card-text>
  </v-card>
</template>
