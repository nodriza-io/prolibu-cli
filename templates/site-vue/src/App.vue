<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterView } from 'vue-router'
import { session, errorText, displayName, type Me } from './session'

const me = ref<Me | null>(null)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    me.value = await session.me()
  } catch (err) {
    error.value = errorText(err)
  }
})
</script>

<template>
  <header class="header">
    <div>
      <h1>Prolibu Site</h1>
      <p class="muted">{{ me ? `Signed in as ${displayName(me)}` : error ?? 'Checking your session…' }}</p>
    </div>
    <co-button v-if="me" variant="stroke" shape="square" @click="session.signOut()">Sign out</co-button>
  </header>

  <main class="main">
    <RouterView v-if="me" />
    <p class="muted">Edit <code>src/App.vue</code> and <code>src/pages/</code> to build your site.</p>
  </main>
</template>
