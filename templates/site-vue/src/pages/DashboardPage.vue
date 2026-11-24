<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { session, errorText } from '../session'

interface Deal {
  _id: string
  dealName?: string
}

const deals = ref<Deal[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  // One small page of records per visit: newest first by _id (indexed), only the fields shown.
  // For totals or many rows, read a Prolibu report instead (see HEAVY-READS.md).
  const query = new URLSearchParams({ limit: '5', sort: '-_id', select: 'dealName' })
  try {
    const res = await session.api<{ data?: Deal[] }>(`/deal?${query}`)
    deals.value = res?.data ?? []
  } catch (err) {
    error.value = errorText(err)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <co-card variant="outlined" padding="sm">
    <h2>Latest deals</h2>
    <co-skeleton v-if="loading" />
    <co-empty-state
      v-else-if="!error && deals.length === 0"
      heading="No deals yet"
      description="Deals you can see will show up here."
      icon="briefcase"
      variant="plain"
    />
    <co-list-item v-for="deal in deals" :key="deal._id" :label="deal.dealName || '(no name)'" icon="briefcase" />
    <co-helper-text v-if="error" status="error">{{ error }}</co-helper-text>
  </co-card>
</template>
