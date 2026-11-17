import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceSplit } from '../src/composables/useWorkspaceSplit.js';
beforeEach(() => localStorage.clear());
describe('shared conversation/pane splitter', () => {
  it('moves only the captured pointer, clamps extremes, persists and restores the ratio', () => {
    const split = useWorkspaceSplit();
    split.element.value = {
      getBoundingClientRect: () => ({ left: 100, width: 1000 }),
    } as HTMLElement;
    const event = (id: number, x: number) =>
      ({
        pointerId: id,
        clientX: x,
        button: 0,
        currentTarget: {},
        preventDefault() {},
      }) as unknown as PointerEvent;
    split.move(event(1, 800));
    expect(split.ratio.value).toBe(52);
    split.start(event(1, 100));
    split.move(event(2, 900));
    expect(split.ratio.value).toBe(52);
    split.move(event(1, 2000));
    expect(split.ratio.value).toBe(75);
    split.move(event(1, 0));
    expect(split.ratio.value).toBe(25);
    split.move(event(1, 700));
    split.end(event(1, 700));
    expect(useWorkspaceSplit().ratio.value).toBe(60);
  });
  it('supports keyboard resizing and ignores corrupt persistence', () => {
    localStorage.setItem('observatory.workspace.split', 'NaN');
    const split = useWorkspaceSplit();
    const key = (key: string) => split.key({ key, preventDefault() {} } as KeyboardEvent);
    key('ArrowRight');
    expect(split.ratio.value).toBe(54);
    key('Home');
    expect(split.ratio.value).toBe(25);
    key('End');
    expect(split.ratio.value).toBe(75);
  });
});
