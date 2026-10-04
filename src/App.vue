<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { useExhibitionStore } from './stores/exhibition';
import { STAGE_LABELS, type Exhibit } from './services/offline';
import ExhibitDialog from './components/ExhibitDialog.vue';
import ConflictsTab from './components/ConflictsTab.vue';
import BatchesTab from './components/BatchesTab.vue';
import SourcesTab from './components/SourcesTab.vue';

const store = useExhibitionStore();
// 页面内的在线状态由「网络开关」驱动，方便演示离线续作
void useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy' | 'conflict' | 'batch' | 'source'>('checkin');
const dialog = ref(false);
const selectedId = ref<string | null>(null);
const snackbar = ref(false);
const snackColor = ref('success');
const snackText = ref('');

const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const apiLabel = computed(() => String(api.defaults.baseURL));

function notice(color: string, text: string) {
  snackColor.value = color;
  snackText.value = text;
  snackbar.value = true;
}

const submit = handleSubmit((values) => {
  const id = store.addExhibit(values);
  dialog.value = false;
  resetForm();
  selectedId.value = id;
});

const deviceItems = computed(() => Object.values(store.devices).map((device) => ({ title: `${device.label}（${device.role}）`, value: device.id })));
const viewExhibits = computed(() => store.view.exhibits);
const queuedCount = computed(() => store.openBatches.reduce((sum, batch) =>
  sum + batch.ops.filter((op) => op.status === 'queued').length, 0));

function rowStage(item: Exhibit) { return STAGE_LABELS[item.stage]; }
function openExhibit(id: string) { selectedId.value = id; }
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-select
        :model-value="store.currentDeviceId" :items="deviceItems" density="compact" variant="solo" hide-details
        prepend-inner-icon="mdi-tablet-cellphone" style="max-width: 260px" class="mr-3"
        @update:model-value="store.switchDevice($event)" />
      <v-btn class="mr-3" :color="store.online ? 'green' : 'orange'" variant="flat" prepend-icon="mdi-connection"
        @click="store.setOnline(!store.online)">
        {{ store.online ? '网络在线' : '离线中（点击恢复）' }}
      </v-btn>
      <v-chip class="mr-3" :color="store.online ? 'green-darken-1' : 'orange-darken-1'" theme="dark">
        {{ store.online ? '在线即时合并' : '离线续作' }}
      </v-chip>
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert :color="store.online ? 'blue-lighten-4' : 'orange-lighten-4'" :icon="store.online ? 'mdi-cloud-check-outline' : 'mdi-cloud-off-outline'" class="mb-5">
          <template v-if="store.online">
            网络正常：操作即时合并。接口地址 {{ apiLabel }}。可点上方「网络在线」模拟现场断网。
          </template>
          <template v-else>
            点交现场断网：每件改动都记下字段、设备号与基线版本，当前各设备本地待回网 {{ queuedCount }} 条。
            切换设备模拟保管员/借展方各自离线修改同一件展品，恢复网络后按字段合并。
          </template>
          <template #append>
            <v-btn v-if="store.blockedBatches.length" color="red" variant="tonal" class="mr-2" @click="tab = 'conflict'">
              {{ store.blockedBatches.length }} 个批次受阻
            </v-btn>
            <v-btn v-if="store.openBatches.length" variant="text" @click="store.mergeAll()">立即合并</v-btn>
          </template>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">待确认字段冲突</div><div class="metric" :class="store.pendingConflicts.length ? 'warn' : ''">{{ store.pendingConflicts.length }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab>
            <v-tab value="environment">{{ $t('environment') }}</v-tab>
            <v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
            <v-tab value="conflict">字段冲突
              <v-chip v-if="store.pendingConflicts.length" size="x-small" color="red" class="ml-1">{{ store.pendingConflicts.length }}</v-chip>
            </v-tab>
            <v-tab value="batch">离线批次
              <v-chip v-if="store.batches.filter((b) => b.status !== 'merged').length" size="x-small" color="orange" class="ml-1">
                {{ store.batches.filter((b) => b.status !== 'merged').length }}
              </v-chip>
            </v-tab>
            <v-tab value="source">来源记录</v-tab>
          </v-tabs>

          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="viewExhibits" height="520" item-height="96">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="openExhibit(item.id)">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}
                      <v-chip x-small class="ml-2" variant="tonal" color="grey">v{{ item.version }}</v-chip>
                      <v-chip v-if="item.returnedAt" x-small class="ml-1" color="green" variant="tonal">已归还</v-chip>
                    </v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · {{ rowStage(item) }}</v-list-item-subtitle>
                    <template #append>
                      <v-chip size="small" :color="item.status === 'issue' ? 'red' : item.status === 'passed' ? 'green' : 'grey'">{{ item.status }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>

            <v-window-item value="environment">
              <v-table>
                <thead><tr><th>展品</th><th>温度</th><th>湿度</th><th>照度</th><th>条件（改动入离线批次）</th></tr></thead>
                <tbody>
                  <tr v-for="item in viewExhibits" :key="item.id" style="cursor: pointer" @click="openExhibit(item.id)">
                    <td>{{ item.code }}</td><td>{{ item.environment.temperature }}℃</td><td>{{ item.environment.humidity }}%</td><td>{{ item.environment.light }} lux</td>
                    <td @click.stop>
                      <v-btn size="small" color="green" variant="text" @click="store.recordCondition(item.id, 'passed')">通过</v-btn>
                      <v-btn size="small" color="red" variant="text" @click="store.recordCondition(item.id, 'issue')">异常</v-btn>
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </v-window-item>

            <v-window-item value="discrepancy">
              <v-list>
                <v-list-item v-for="item in store.view.discrepancies" :key="item.id">
                  <v-list-item-title>{{ item.title }}
                    <v-chip x-small class="ml-2" :color="item.severity === 'major' ? 'red' : 'amber'" variant="tonal">
                      {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}
                    </v-chip>
                  </v-list-item-title>
                  <v-list-item-subtitle>展品 {{ item.exhibitId }}</v-list-item-subtitle>
                  <template #append><v-btn :disabled="item.resolved" color="green" variant="tonal" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template>
                </v-list-item>
              </v-list>
            </v-window-item>

            <v-window-item value="conflict"><ConflictsTab /></v-window-item>
            <v-window-item value="batch"><BatchesTab /></v-window-item>
            <v-window-item value="source"><SourcesTab /></v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text>
              <v-form @submit.prevent="submit">
                <v-text-field v-model="code" label="展品编号" :error-messages="errors.code" />
                <v-text-field v-model="name" label="展品名称" :error-messages="errors.name" />
                <v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" />
                <v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" />
                <v-btn type="submit" color="deep-purple" block>写入点交批次</v-btn>
              </v-form>
            </v-card-text>
          </v-card>
        </v-dialog>

        <ExhibitDialog :model-value="Boolean(selectedId)" :exhibit-id="selectedId" @update:model-value="(v) => { if (!v) selectedId = null; }" @notice="notice" />

        <v-snackbar v-model="snackbar" :color="snackColor" timeout="3200">{{ snackText }}</v-snackbar>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
</style>
