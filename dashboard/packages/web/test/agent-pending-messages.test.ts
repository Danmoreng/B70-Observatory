import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import AgentPendingMessages from '../src/components/agent/AgentPendingMessages.vue';
import { setLocale } from '../src/lib/i18n.js';

afterEach(() => setLocale('en'));

describe('messages awaiting actual delivery', () => {
  it('keeps the full message and honest delivery states outside the input', () => {
    const text = `First line\n${'Long message '.repeat(100)}\nLast line`;
    const wrapper = mount(AgentPendingMessages, {
      props: {
        pendingSteering: 2,
        deliveries: [
          { id: '1', text, status: 'acknowledged' },
          { id: '2', text: 'Check delivery', status: 'uncertain' },
          { id: '3', text: 'Cancelled message', status: 'cancelled' },
        ],
      },
    });
    expect(wrapper.get('section').attributes('aria-label')).toBe('Sent messages');
    expect(wrapper.get('.queue-note').text()).toBe('2 comment(s) waiting to be delivered.');
    expect(wrapper.get('.steering-deliveries span').element.textContent).toBe(text);
    expect(wrapper.text()).toContain('Accepted by Pi');
    expect(wrapper.text()).toContain('Delivery uncertain');
    expect(wrapper.text()).not.toContain('Cancelled message');
    expect(wrapper.find('form, textarea, details').exists()).toBe(false);
    wrapper.unmount();
  });

  it('removes a message only on actual delivery and leaves no empty region', async () => {
    const message = { id: '1', text: 'Apply now', status: 'acknowledged' };
    const wrapper = mount(AgentPendingMessages, {
      props: { pendingSteering: 1, deliveries: [message] },
    });
    expect(wrapper.text()).toContain(message.text);
    await wrapper.setProps({
      pendingSteering: 0,
      deliveries: [{ ...message, confirmedAt: '2026-10-22T20:00:00.000Z' }],
    });
    expect(wrapper.find('.pending-messages').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the pending count while the message ledger is being refreshed, in German', () => {
    setLocale('de');
    const wrapper = mount(AgentPendingMessages, {
      props: { pendingSteering: 1, deliveries: [] },
    });
    expect(wrapper.get('section').attributes('aria-label')).toBe('Gesendete Nachrichten');
    expect(wrapper.get('.queue-note').text()).toBe('1 Kommentar(e) warten auf Zustellung.');
    wrapper.unmount();
  });
});
