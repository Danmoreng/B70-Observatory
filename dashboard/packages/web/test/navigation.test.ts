import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AppSidebar from '../src/components/AppSidebar.vue';

describe('compact application navigation', () => {
  const baseProps = {
    page: 'overview' as const,
    collapsed: false,
    connection: 'connected' as const,
    sync: 'none' as const,
    loginRequired: true,
    signingOut: false,
  };

  it('contains coding and studio destinations and marks the active page', () => {
    const wrapper = mount(AppSidebar, { props: { ...baseProps, page: 'agent' } });
    const links = wrapper.findAll('nav a');
    expect(wrapper.findAll('.sidebar-label').map((label) => label.text())).toEqual([
      'Overview',
      'Tasks',
      'Projects',
      'Image studio',
      'Gallery',
      'Computer',
      'Memory',
      'Settings',
    ]);
    expect(links[0]?.attributes('href')).toBe('#/overview');
    expect(links[1]?.attributes('href')).toBe('#/agent');
    expect(links[1]?.attributes('aria-current')).toBe('page');
    expect(links[2]?.attributes('href')).toBe('#/projects');
    expect(links[3]?.attributes('href')).toBe('#/studio');
    expect(links[4]?.attributes('href')).toBe('#/gallery');
    expect(links[5]?.attributes('href')).toBe('#/hardware');
    expect(links[6]?.attributes('href')).toBe('#/memory');
  });

  it('exposes an accessible collapse action', async () => {
    const wrapper = mount(AppSidebar, { props: { ...baseProps, collapsed: true } });
    const toggle = wrapper.get('.sidebar-toggle');
    expect(toggle.attributes('aria-label')).toBe('Expand navigation');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    expect(wrapper.emitted('toggle')).toHaveLength(1);
  });

  it('contains connection and sign-out controls instead of leaving them in page content', async () => {
    const wrapper = mount(AppSidebar, { props: baseProps });
    expect(wrapper.get('.sidebar-connection').text()).toBe('Connected');
    expect(wrapper.get('.sidebar-connection').attributes('role')).toBe('status');
    await wrapper.get('.sidebar-signout').trigger('click');
    expect(wrapper.emitted('signOut')).toHaveLength(1);
  });

  it('hides the sign-out action when browser login is not required', () => {
    const wrapper = mount(AppSidebar, { props: { ...baseProps, loginRequired: false } });
    expect(wrapper.find('.sidebar-signout').exists()).toBe(false);
    expect(wrapper.find('.sidebar-connection').exists()).toBe(true);
  });
});
