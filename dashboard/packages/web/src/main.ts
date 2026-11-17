import { createApp, watch } from 'vue';
import App from './App.vue';
import { locale } from './lib/i18n.js';
import './styles.css';

// Keep the document language in step with the UI locale (a11y, spellcheck).
const syncHtmlLang = (): void => {
  document.documentElement.lang = locale.value;
};
syncHtmlLang();
watch(locale, syncHtmlLang);

createApp(App).mount('#app');
