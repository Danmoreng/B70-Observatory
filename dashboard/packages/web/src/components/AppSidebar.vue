<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../lib/i18n.js';
import AppIcon from './AppIcon.vue';
import { useProjectPins } from '../composables/useProjectPins.js';
const { pins } = useProjectPins();

const props = defineProps<{
  page:
    'overview' | 'agent' | 'projects' | 'hardware' | 'memory' | 'studio' | 'gallery' | 'settings';
  collapsed: boolean;
  connection: 'connecting' | 'connected' | 'reconnecting';
  sync: 'none' | 'replay' | 'resync';
  /** Operator browser-auth mode: hide the sign-out action when no login applies. */
  loginRequired: boolean;
  signingOut: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  signOut: [];
}>();

const items = [
  {
    page: 'overview' as const,
    href: '#/overview',
    labelKey: 'sidebar.overview' as const,
    icon: 'home',
  },
  { page: 'agent' as const, href: '#/agent', labelKey: 'sidebar.tasks' as const, icon: 'tasks' },
  {
    page: 'projects' as const,
    href: '#/projects',
    labelKey: 'sidebar.projects' as const,
    icon: 'folder',
  },
  { page: 'studio' as const, href: '#/studio', labelKey: 'studio.title' as const, icon: 'studio' },
  {
    page: 'gallery' as const,
    href: '#/gallery',
    labelKey: 'studio.gallery' as const,
    icon: 'gallery',
  },
  {
    page: 'hardware' as const,
    href: '#/hardware',
    labelKey: 'sidebar.hardware' as const,
    icon: 'computer',
  },
  { page: 'memory' as const, href: '#/memory', labelKey: 'memory.title' as const, icon: 'memory' },
  {
    page: 'settings' as const,
    href: '#/settings',
    labelKey: 'settings.title' as const,
    icon: 'settings',
  },
] as const;

const connectionLabel = computed(() => {
  if (props.connection === 'reconnecting') return t('sidebar.disconnected');
  if (props.sync === 'resync') return t('sidebar.resyncing');
  if (props.sync === 'replay') return t('sidebar.replaying');
  return props.connection === 'connected' ? t('sidebar.connected') : t('sidebar.connecting');
});
</script>

<template>
  <aside class="app-sidebar" :class="{ collapsed }">
    <div class="sidebar-brand">
      <a href="#/overview" :aria-label="t('sidebar.brandAria')">
        <span class="sidebar-logo" aria-hidden="true">B70</span>
        <span class="sidebar-name">Observatory</span>
      </a>
      <button
        class="sidebar-toggle"
        type="button"
        :aria-label="collapsed ? t('sidebar.expand') : t('sidebar.collapse')"
        :aria-expanded="!collapsed"
        @click="emit('toggle')"
      >
        <AppIcon :name="collapsed ? 'right' : 'left'" />
      </button>
    </div>
    <nav :aria-label="t('sidebar.mainNav')">
      <a
        v-for="item in items"
        :key="item.page"
        :href="item.href"
        :aria-current="page === item.page ? 'page' : undefined"
        :title="collapsed ? t(item.labelKey) : undefined"
        :aria-label="t(item.labelKey)"
      >
        <span class="sidebar-mark" aria-hidden="true">
          <AppIcon :name="item.icon" />
        </span>
        <span class="sidebar-label">{{ t(item.labelKey) }}</span>
      </a>
    </nav>
    <nav v-if="pins.length" class="sidebar-pins" :aria-label="t('pins.title')">
      <p class="sidebar-label">{{ t('pins.title') }}</p>
      <a
        v-for="pin in pins"
        :key="pin.id"
        :href="`#/projects/${encodeURIComponent(pin.id)}`"
        :title="pin.name"
        ><span class="sidebar-mark" aria-hidden="true">{{ pin.name.slice(0, 2) }}</span
        ><span class="sidebar-label">{{ pin.name }}</span></a
      >
    </nav>
    <div class="sidebar-session">
      <span
        class="live-chip sidebar-connection"
        :class="[connection, `sync-${sync}`]"
        role="status"
        :title="connectionLabel"
      >
        <span class="live-dot" aria-hidden="true"></span>
        <span class="sidebar-session-label">{{ connectionLabel }}</span>
      </span>
      <button
        v-if="loginRequired"
        class="quiet-button sidebar-signout"
        type="button"
        :disabled="signingOut"
        :aria-label="signingOut ? t('sidebar.signingOutAria') : t('sidebar.signOut')"
        @click="emit('signOut')"
      >
        <AppIcon name="logout" />
        <span class="sidebar-signout-label">{{
          signingOut ? t('sidebar.signingOut') : t('sidebar.signOut')
        }}</span>
      </button>
    </div>
  </aside>
</template>
