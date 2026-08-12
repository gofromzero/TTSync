<script setup lang="ts">
import { onMounted, ref } from 'vue';

const activeRole = ref<'host' | 'participant' | 'spectator'>('host');
const email = ref('');
const password = ref('');
const resendEmail = ref('');
const registerMessage = ref('');
const resendMessage = ref('');
const verificationMessage = ref('');
const registering = ref(false);
const resending = ref(false);
const acceptedMessage = '请求已受理，请查收邮件。';
const requestFailedMessage = '请求失败，请稍后重试。';
const csrf = () => document.cookie.split('; ').find((value) => value.startsWith('__Host-ttsync-csrf='))?.slice('__Host-ttsync-csrf='.length) ?? '';

async function post(path: '/api/v1/accounts' | '/api/v1/accounts/verification/resend' | '/api/v1/accounts/verification', body: object) {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() },
    body: JSON.stringify(body),
  });
}

async function register() {
  registering.value = true;
  registerMessage.value = '';
  try {
    const response = await post('/api/v1/accounts', { email: email.value, password: password.value });
    registerMessage.value = response.status === 200 ? acceptedMessage : requestFailedMessage;
  } catch {
    registerMessage.value = requestFailedMessage;
  } finally {
    registering.value = false;
  }
}

async function resend() {
  resending.value = true;
  resendMessage.value = '';
  try {
    const response = await post('/api/v1/accounts/verification/resend', { email: resendEmail.value });
    resendMessage.value = response.status === 200 ? acceptedMessage : requestFailedMessage;
  } catch {
    resendMessage.value = requestFailedMessage;
  } finally {
    resending.value = false;
  }
}

onMounted(async () => {
  const token = new URLSearchParams(location.search).get('token');
  if (token === null) return;
  history.replaceState(null, '', '/verify');
  try {
    const response = await post('/api/v1/accounts/verification', { token });
    verificationMessage.value = response.status === 200 ? '邮箱已验证。' : '验证链接无效或已失效。';
  } catch {
    verificationMessage.value = '验证链接无效或已失效。';
  }
});
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
    <section class="account-card" aria-label="账号注册与邮箱验证">
      <h2>创建账号</h2>
      <form class="account-form" aria-label="创建账号" @submit.prevent="register">
        <label for="register-email">注册邮箱</label>
        <input id="register-email" name="email" v-model="email" type="email" autocomplete="email">
        <label for="register-password">注册密码</label>
        <input id="register-password" name="password" v-model="password" type="password" autocomplete="new-password">
        <button type="submit" :disabled="registering">注册账号</button>
        <p role="status" aria-live="polite">{{ registerMessage }}</p>
      </form>
      <h2>重发验证邮件</h2>
      <form class="account-form" aria-label="重发验证邮件" @submit.prevent="resend">
        <label for="resend-email">邮箱</label>
        <input id="resend-email" name="email" v-model="resendEmail" type="email" autocomplete="email">
        <button type="submit" :disabled="resending">重发验证邮件</button>
        <p role="status" aria-live="polite">{{ resendMessage }}</p>
      </form>
      <p role="status" aria-live="polite">{{ verificationMessage }}</p>
    </section>
  </main>
</template>
