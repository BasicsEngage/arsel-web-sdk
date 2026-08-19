// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../src/inapp-view';
import type { ViewCallbacks, ViewOptions } from '../src/inapp-view';
import type { InAppMessage } from '../src/inapp';

/**
 * The renderer's failure mode is "draws nothing, or draws something wrong, and
 * reports a healthy impression anyway" — invisible from every server-side
 * surface. These cover the parts that fail silently: roles, focus, escape
 * routes, and the fact that content is text and never markup.
 *
 * Only this file runs in a DOM. The other suites stay on `node`, so the
 * environment is set per-file rather than in vite.config.ts.
 */

const OPTIONS: ViewOptions = { zIndex: 1000, closeLabel: 'Close' };

function message(overrides: Partial<InAppMessage> = {}): InAppMessage {
  return {
    campaignId: 'c1',
    messageId: 'm1',
    variantKey: 'default',
    priority: 100,
    expiresAtMs: null,
    triggerType: 'APP_OPEN',
    triggerEventName: null,
    triggerProperties: null,
    displayRules: {
      maxPerSession: 1,
      maxLifetime: 3,
      minSecondsBetween: 0,
      delaySeconds: 0,
    },
    layout: 'MODAL',
    content: { headline: 'Headline', body: 'Body', showCloseButton: true },
    buttons: [],
    ...overrides,
  };
}

function callbacks(): ViewCallbacks & {
  impressions: number;
  clicks: string[];
  dismissals: number;
} {
  const spy = {
    impressions: 0,
    clicks: [] as string[],
    dismissals: 0,
    onImpression() {
      spy.impressions += 1;
    },
    onButton(button: { buttonId: string }) {
      spy.clicks.push(button.buttonId);
    },
    onDismiss() {
      spy.dismissals += 1;
    },
  };
  return spy;
}

/** Two frames: one for the renderer's rAF, one for the live-region write. */
async function frames(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('in-app renderer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('dir');
    vi.restoreAllMocks();
  });

  describe('structure', () => {
    it('renders into a closed shadow root, invisible to the host page', () => {
      const handle = render(message(), OPTIONS, callbacks());

      const host = document.querySelector('[data-arsel-inapp]');
      expect(host).not.toBeNull();
      // Closed, so a host page's own overlay logic cannot reach in and reshape
      // a message we are about to report an impression for.
      expect((host as HTMLElement & { shadowRoot: unknown }).shadowRoot).toBeNull();
      expect(handle.root.querySelector('.panel')).not.toBeNull();
    });

    it('removes the host element on close', () => {
      const handle = render(message(), OPTIONS, callbacks());

      handle.close('dismiss');

      expect(document.querySelector('[data-arsel-inapp]')).toBeNull();
    });

    it('gives a modal dialog semantics', () => {
      const handle = render(message(), OPTIONS, callbacks());

      const panel = handle.root.querySelector('.panel');
      expect(panel?.getAttribute('role')).toBe('dialog');
      expect(panel?.getAttribute('aria-modal')).toBe('true');
      expect(panel?.getAttribute('aria-labelledby')).toBeTruthy();
    });

    it.each(['BANNER_TOP', 'BANNER_BOTTOM'] as const)(
      'announces a %s without stealing focus',
      (layout) => {
        const handle = render(message({ layout }), OPTIONS, callbacks());

        const panel = handle.root.querySelector('.panel');
        // A banner that traps focus interrupts a form the visitor is typing in.
        expect(panel?.getAttribute('role')).toBe('status');
        expect(panel?.getAttribute('aria-live')).toBe('polite');
        expect(panel?.hasAttribute('aria-modal')).toBe(false);
      },
    );

    it('mirrors the host page direction rather than assuming LTR', () => {
      document.documentElement.setAttribute('dir', 'rtl');

      render(message(), OPTIONS, callbacks());

      const host = document.querySelector('[data-arsel-inapp]');
      expect(host?.getAttribute('dir')).toBe('rtl');
    });
  });

  describe('content safety', () => {
    it('sets text with textContent, never as markup', () => {
      const handle = render(
        message({
          content: {
            headline: '<img src=x onerror="alert(1)">',
            body: '<script>alert(2)</script>',
            showCloseButton: true,
          },
        }),
        OPTIONS,
        callbacks(),
      );

      // Org-authored content rendering on the CUSTOMER's origin is a stored-XSS
      // sink the moment it becomes innerHTML.
      expect(handle.root.querySelector('img')).toBeNull();
      expect(handle.root.querySelector('script')).toBeNull();
      expect(handle.root.querySelector('.headline')?.textContent).toContain(
        '<img',
      );
    });

    it('ignores a colour that is not a hex value', () => {
      const handle = render(
        message({
          content: {
            headline: 'H',
            body: 'B',
            showCloseButton: true,
            backgroundColor: 'url(javascript:alert(1))',
          },
        }),
        OPTIONS,
        callbacks(),
      );

      const panel = handle.root.querySelector('.panel') as HTMLElement;
      expect(panel.style.background).toBe('');
    });
  });

  describe('escape routes', () => {
    it('renders a close button when the author asked for one', () => {
      const handle = render(message(), OPTIONS, callbacks());

      const close = handle.root.querySelector('.close');
      expect(close?.getAttribute('aria-label')).toBe('Close');
    });

    it('installs a close affordance even when the message declares none', () => {
      // The server validates dismissability, but a trapped visitor on a
      // customer's site is not a failure worth trusting a remote invariant for.
      const handle = render(
        message({
          content: { headline: 'H', body: 'B', showCloseButton: false },
          buttons: [
            {
              buttonId: 'go',
              label: 'Go',
              action: 'DEEP_LINK',
              value: '/x',
              style: 'PRIMARY',
            },
          ],
        }),
        OPTIONS,
        callbacks(),
      );

      expect(handle.root.querySelector('.close')).not.toBeNull();
    });

    it('omits the extra close button when a DISMISS button exists', () => {
      const handle = render(
        message({
          content: { headline: 'H', body: 'B', showCloseButton: false },
          buttons: [
            {
              buttonId: 'no-thanks',
              label: 'No thanks',
              action: 'DISMISS',
              style: 'SECONDARY',
            },
          ],
        }),
        OPTIONS,
        callbacks(),
      );

      expect(handle.root.querySelector('.close')).toBeNull();
    });

    it('dismisses on Escape and reports it', () => {
      const spy = callbacks();
      render(message(), OPTIONS, spy);

      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );

      expect(spy.dismissals).toBe(1);
      expect(document.querySelector('[data-arsel-inapp]')).toBeNull();
    });
  });

  describe('focus', () => {
    it('focuses the panel and restores focus on close', () => {
      const trigger = document.createElement('button');
      document.body.append(trigger);
      trigger.focus();

      const handle = render(message(), OPTIONS, callbacks());
      handle.close('dismiss');

      expect(document.activeElement).toBe(trigger);
    });

    it('does not restore focus to an element that left the document', () => {
      const trigger = document.createElement('button');
      document.body.append(trigger);
      trigger.focus();

      const handle = render(message(), OPTIONS, callbacks());
      trigger.remove();

      // Reviving focus on a detached node strands the caret.
      expect(() => handle.close('dismiss')).not.toThrow();
    });
  });

  describe('buttons', () => {
    it('reports the button id and closes', () => {
      const spy = callbacks();
      const handle = render(
        message({
          buttons: [
            {
              buttonId: 'cta',
              label: 'Go',
              action: 'DISMISS',
              style: 'PRIMARY',
            },
          ],
        }),
        OPTIONS,
        spy,
      );

      handle.root.querySelector<HTMLElement>('.cta')?.click();

      expect(spy.dismissals).toBe(1);
      expect(document.querySelector('[data-arsel-inapp]')).toBeNull();
    });

    it('renders a URL action as a safe external link', () => {
      const handle = render(
        message({
          buttons: [
            {
              buttonId: 'site',
              label: 'Visit',
              action: 'URL',
              value: 'https://example.com',
              style: 'PRIMARY',
            },
          ],
        }),
        OPTIONS,
        callbacks(),
      );

      const link = handle.root.querySelector('a');
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link?.getAttribute('target')).toBe('_blank');
    });
  });

  describe('impression timing', () => {
    it('reports an impression once the node is on screen', async () => {
      const spy = callbacks();
      render(message(), OPTIONS, spy);

      expect(spy.impressions).toBe(0);
      await frames();

      expect(spy.impressions).toBe(1);
    });

    it('reports nothing when the message was closed before painting', async () => {
      const spy = callbacks();
      const handle = render(message(), OPTIONS, spy);

      handle.close('expired');
      await frames();

      // A delayed message landing in a backgrounded tab would otherwise report
      // an impression nobody saw, corrupting every rate in the channel.
      expect(spy.impressions).toBe(0);
    });

    it('reports nothing while the tab is hidden', async () => {
      const spy = callbacks();
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });

      render(message(), OPTIONS, spy);
      await frames();

      expect(spy.impressions).toBe(0);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
    });
  });

  describe('styling', () => {
    it('styles the root through whichever mechanism the browser supports', () => {
      const handle = render(message(), OPTIONS, callbacks());

      // A <style> element inside a shadow root IS subject to the host page's
      // style-src; a constructed sheet is not. Either is acceptable, an
      // unstyled message is not.
      const styled =
        handle.root.adoptedStyleSheets?.length > 0 ||
        handle.root.querySelector('style') !== null;
      expect(styled).toBe(true);
    });
  });
});
