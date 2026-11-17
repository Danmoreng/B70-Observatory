import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AgentDiffView from '../src/components/agent/AgentDiffView.vue';

describe('AgentDiffView', () => {
  it('never renders historic Git binary patches or image bytes as text', () => {
    const wrapper = mount(AgentDiffView, {
      props: {
        files: ['hero.png'],
        diff: 'diff --git a/hero.png b/hero.png\nnew file mode 100644\nGIT binary patch\nliteral 123\nBINARY_SECRET_CONTENT\n',
      },
    });
    expect(wrapper.text()).toContain('hero.png');
    expect(wrapper.text()).not.toContain('BINARY_SECRET_CONTENT');
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.find('.binary-file-notice').exists()).toBe(true);
    wrapper.unmount();
  });
  it('selects one file at a time and keeps missing truncated patches explicit', async () => {
    const wrapper = mount(AgentDiffView, {
      props: {
        truncated: true,
        files: ['src/a.ts', 'src/b.ts', 'binary.png'],
        diff: ' src/a.ts | 2 +-\n 2 files changed, 2 insertions(+)\n\ndiff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old-a\n+new-a\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old-b\n+new-b',
      },
    });
    expect(wrapper.findAll('.diff-file-list button')).toHaveLength(3);
    expect(wrapper.get('table').text()).toContain('new-a');
    expect(wrapper.get('table').text()).not.toContain('new-b');
    await wrapper.get('[data-file="src/b.ts"]').trigger('click');
    expect(wrapper.get('table').text()).toContain('new-b');
    expect(wrapper.get('table').text()).not.toContain('new-a');
    expect(wrapper.get('[role="status"]').text()).toContain('truncated');
    await wrapper.get('[data-file="binary.png"]').trigger('click');
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.find('.binary-file-notice').exists()).toBe(true);
  });

  it('renders unified additions, deletions and context with old and new line numbers', () => {
    const wrapper = mount(AgentDiffView, {
      props: {
        diff: [
          'diff --git a/src/value.js b/src/value.js',
          '--- a/src/value.js',
          '+++ b/src/value.js',
          '@@ -2,2 +2,2 @@',
          ' unchanged',
          '-old value',
          '+new value',
        ].join('\n'),
      },
    });

    expect(wrapper.get('.diff-file-heading code').text()).toBe('src/value.js');
    expect(
      wrapper
        .get('tr.context')
        .findAll('td')
        .map((cell) => cell.text())
    ).toEqual(['2', '2', 'unchanged']);
    expect(
      wrapper
        .get('tr.deletion')
        .findAll('td')
        .map((cell) => cell.text())
    ).toEqual(['3', '', '-old value']);
    expect(
      wrapper
        .get('tr.addition')
        .findAll('td')
        .map((cell) => cell.text())
    ).toEqual(['', '3', '+new value']);
  });

  it('previews run-bound image changes, keeps binary bytes hidden and recovers after another selection', async () => {
    const wrapper = mount(AgentDiffView, {
      props: { taskId: 'task', runId: 'run', diff: '', files: ['one.png', 'two.webp'] },
    });
    expect(wrapper.get('.diff-image-preview img').attributes('src')).toContain(
      'runId=run&path=one.png'
    );
    await wrapper.get('img').trigger('error');
    expect(wrapper.find('.diff-image-preview').exists()).toBe(false);
    expect(wrapper.text()).toContain('Image preview unavailable');
    await wrapper.get('[data-file="two.webp"]').trigger('click');
    expect(wrapper.get('img').attributes('src')).toContain('path=two.webp');
  });
  it('shows a compact empty result instead of an empty code frame', () => {
    const wrapper = mount(AgentDiffView, { props: { diff: '' } });

    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.get('.diff-empty').text()).toBe('No code changes.');
  });
});
