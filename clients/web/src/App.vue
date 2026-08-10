<script setup lang="ts">
import { ref } from 'vue';
const activeRole = ref('host');
</script>
<template>
  <main class="shell">
    <header class="hero">
      <span class="eyebrow">PERSONAL PLAYTEST</span>
      <h1>TTSync</h1>
      <p>同一张桌面，不同的角色视角。</p>
    </header>
    <section class="role-card" aria-label="角色视图">
      <nav class="role-tabs" role="tablist" aria-label="选择角色视图">
        <button role="tab" type="button" :aria-selected="activeRole === 'host'" @click="activeRole = 'host'">主持人视图</button>
        <button role="tab" type="button" :aria-selected="activeRole === 'participant'" @click="activeRole = 'participant'">参与者视图</button>
        <button role="tab" type="button" :aria-selected="activeRole === 'spectator'" @click="activeRole = 'spectator'">观众视图</button>
      </nav>
      <div class="role-panel">
        <p v-if="activeRole === 'host'"><strong>主持人视图</strong>将用于组织当前房间。</p>
        <p v-else-if="activeRole === 'participant'"><strong>参与者视图</strong>将用于查看自己的桌面信息。</p>
        <p v-else><strong>观众视图</strong>将用于只读关注当前进展。</p>
      </div>
    </section>
  </main>
</template>
