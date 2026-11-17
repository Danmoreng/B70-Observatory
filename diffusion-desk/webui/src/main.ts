import { createApp } from 'vue'
import { createPinia } from 'pinia'

import 'bootstrap/dist/css/bootstrap.min.css'
import './islands.css'
import 'bootstrap-icons/font/bootstrap-icons.css'
import 'bootstrap/dist/js/bootstrap.bundle.min.js'
import './style.css'

async function mount() {
  if (import.meta.env.MODE === 'comfyui') {
    const { default: ComfyDesk } = await import('./comfyui/ComfyDesk.vue')
    createApp(ComfyDesk).mount('#app')
    return
  }
  const [{ default: App }, { default: router }] = await Promise.all([
    import('./App.vue'), import('./router'),
  ])
  createApp(App).use(createPinia()).use(router).mount('#app')
}

void mount()
