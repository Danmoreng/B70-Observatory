import { ref, watch } from 'vue';
export type Density = 'standard' | 'compact';
function stored(): Density {
  try {
    return localStorage.getItem('observatory.density') === 'compact' ? 'compact' : 'standard';
  } catch {
    return 'standard';
  }
}
export const density = ref<Density>(stored());
watch(
  density,
  (value) => {
    if (typeof document !== 'undefined') document.documentElement.dataset.density = value;
    try {
      localStorage.setItem('observatory.density', value);
    } catch {
      /* session only */
    }
  },
  { immediate: true }
);
