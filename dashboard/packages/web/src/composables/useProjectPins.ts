import { ref } from 'vue';

interface ProjectPin {
  id: string;
  name: string;
}
const key = 'observatory.project-pins.v1';
function readPins(): ProjectPin[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value
      .filter((pin): pin is ProjectPin => {
        if (
          pin === null ||
          typeof pin !== 'object' ||
          typeof pin.id !== 'string' ||
          typeof pin.name !== 'string' ||
          pin.id.length > 200 ||
          pin.name.length > 200 ||
          !pin.id ||
          !pin.name ||
          seen.has(pin.id)
        )
          return false;
        seen.add(pin.id);
        return true;
      })
      .slice(0, 100)
      .map(({ id, name }) => ({ id, name }));
  } catch {
    return [];
  }
}
const pins = ref<ProjectPin[]>(readPins());
const persistenceFailed = ref(false);
function togglePin(project: ProjectPin): void {
  if (pins.value.some((pin) => pin.id === project.id))
    pins.value = pins.value.filter((pin) => pin.id !== project.id);
  else pins.value = [...pins.value, { id: project.id, name: project.name }].slice(-100);
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(pins.value));
    persistenceFailed.value = false;
  } catch {
    persistenceFailed.value = true;
  }
}
export function useProjectPins() {
  return {
    pins,
    persistenceFailed,
    togglePin,
    isPinned: (id: string) => pins.value.some((pin) => pin.id === id),
  };
}
