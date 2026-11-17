<script setup lang="ts">
import { ref } from 'vue';
import AppButton from './AppButton.vue';
import AppNotice from './AppNotice.vue';
import LocaleSwitcher from './LocaleSwitcher.vue';
import { t } from '../lib/i18n.js';

const props = defineProps<{
  auth: 'checking' | 'signed-out' | 'signing-in' | 'signed-in';
  error: string;
}>();
const emit = defineEmits<{ (event: 'submit', password: string): void }>();
const password = ref('');

function submit(): void {
  emit('submit', password.value);
  password.value = '';
}
</script>

<template>
  <header class="masthead">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">B70</div>
      <div><h1>B70 Observatory</h1></div>
    </div>
  </header>
  <section class="login-shell">
    <div class="login-copy">
      <p class="eyebrow">{{ t('login.eyebrow') }}</p>
      <h2>{{ t('login.headline1') }}<br />{{ t('login.headline2') }}</h2>
      <p>{{ t('login.subline') }}</p>
    </div>
    <form class="panel login-panel" aria-labelledby="login-title" @submit.prevent="submit">
      <h2 id="login-title">{{ t('login.title') }}</h2>
      <p>{{ t('login.hint') }}</p>
      <label for="password">{{ t('login.password') }}</label>
      <input
        id="password"
        v-model="password"
        type="password"
        autocomplete="current-password"
        required
        autofocus
        :disabled="props.auth === 'signing-in'"
        :aria-describedby="props.error ? 'login-error' : undefined"
      />
      <AppNotice v-if="props.error" id="login-error" kind="error" :text="props.error" />
      <AppButton variant="primary" type="submit" :loading="props.auth === 'signing-in'">
        {{ props.auth === 'signing-in' ? t('login.checking') : t('login.submit') }}
      </AppButton>
      <p class="session-note">{{ t('login.sessionNote') }}</p>
      <div class="login-locale">
        <span class="locale-caption">{{ t('locale.label') }}</span>
        <LocaleSwitcher />
      </div>
    </form>
  </section>
</template>
