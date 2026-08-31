import type { InAppButton, InAppMessage } from './inapp';

/**
 * The only module in the SDK that touches the DOM.
 *
 * Everything here renders into a CLOSED shadow root on a host element appended
 * to `document.body`. Closed rather than open so a host page's own scripts and
 * overlay logic cannot reach in and reshape a message we are about to report an
 * impression for. The root is exposed on the returned handle purely as a test
 * seam and is never re-exported from `index.ts`.
 *
 * Two rules run through all of it: text is set with `textContent` only, because
 * the content is org-authored and renders on the CUSTOMER's origin; and nothing
 * mutates the host page's own nodes, because that is the class of breakage
 * nobody ever traces back to an SDK.
 */

const DEFAULT_Z_INDEX = 2_147_483_000;
const MIN_TAP_TARGET_PX = 44;
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
/** Above this relative luminance a background is treated as light. */
const LIGHT_LUMINANCE = 0.6;

let sheet: CSSStyleSheet | null = null;
let idCounter = 0;

export interface ViewOptions {
  zIndex: number;
  closeLabel: string;
}

export interface ViewCallbacks {
  onImpression(): void;
  onButton(button: InAppButton): void;
  onDismiss(visibleSeconds: number): void;
}

export interface ViewHandle {
  close(reason: 'dismiss' | 'button' | 'expired'): void;
  /** Internal test seam. Never re-exported from the public entry point. */
  readonly root: ShadowRoot;
}

export function render(
  message: InAppMessage,
  options: ViewOptions,
  callbacks: ViewCallbacks,
): ViewHandle {
  const isModal = message.layout === 'MODAL';
  const shownAt = Date.now();
  const uid = `arsel-iam-${(idCounter += 1)}`;

  const host = document.createElement('div');
  host.setAttribute('data-arsel-inapp', '');
  const root = host.attachShadow({ mode: 'closed' });
  applyStyles(root);

  // Set through CSSOM, never `setAttribute('style', …)`: the latter is governed
  // by `style-src-attr` and dies under a customer's strict CSP.
  host.style.setProperty('z-index', String(options.zIndex || DEFAULT_Z_INDEX));
  host.style.setProperty('isolation', 'isolate');
  host.setAttribute('data-layout', message.layout);
  // A host-site concern, not the Arsel dashboard's LTR convention.
  host.setAttribute('dir', readDirection());

  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.tabIndex = -1;
  if (isModal) {
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', `${uid}-h`);
    if (message.content.body) panel.setAttribute('aria-describedby', `${uid}-b`);
  } else {
    // Banners must not steal focus: the visitor may be typing into a form.
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
  }

  const colors = resolveColors(message);
  if (colors.background) {
    panel.style.setProperty('background', colors.background);
  }
  if (colors.text) panel.style.setProperty('color', colors.text);

  let closed = false;
  const close = (reason: 'dismiss' | 'button' | 'expired'): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onEscape, true);
    host.remove();
    // Restore focus to whatever had it, unless that node has since left the
    // document — reviving focus on a detached element strands the caret.
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
    else if (isModal) document.body.focus?.();
    if (reason === 'dismiss') {
      callbacks.onDismiss((Date.now() - shownAt) / 1000);
    }
  };

  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close('dismiss');
  };

  if (message.layout === 'IMAGE_ONLY' && message.content.imageUrl) {
    panel.append(buildImageOnly(message, () => primaryAction(message)));
  } else {
    if (message.content.imageUrl) {
      panel.append(buildFigure(message.content.imageUrl, message.content.headline));
    }
    const headline = document.createElement('h2');
    headline.id = `${uid}-h`;
    headline.className = 'headline';
    headline.textContent = message.content.headline;
    panel.append(headline);

    if (message.content.body) {
      const body = document.createElement('p');
      body.id = `${uid}-b`;
      body.className = 'body';
      body.textContent = message.content.body;
      panel.append(body);
    }
  }

  if (message.buttons.length > 0) {
    panel.append(buildButtonRow(message, callbacks, close));
  }

  // If a message somehow arrives with no way out, install one anyway: the
  // server validates this, but a trapped visitor on a customer's site is not a
  // failure mode worth trusting a remote invariant for.
  const needsClose =
    message.content.showCloseButton ||
    !message.buttons.some((button) => button.action === 'DISMISS');
  if (needsClose) {
    panel.append(buildCloseButton(options.closeLabel, () => close('dismiss')));
  }

  if (isModal) {
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    // Only dismissable by backdrop when the author allowed a close affordance;
    // otherwise a stray click destroys a message they meant to be deliberate.
    if (message.content.showCloseButton) {
      backdrop.addEventListener('click', () => close('dismiss'));
    }
    root.append(backdrop);
  }
  root.append(panel);
  document.body.append(host);

  if (isModal) {
    panel.focus({ preventScroll: true });
    root.addEventListener('keydown', (event) => {
      if (event instanceof KeyboardEvent) trapFocus(event, root);
    });
  } else {
    // A live region populated in the same task as its insertion is not
    // announced, so the text lands on the next frame.
    const announced = panel.textContent ?? '';
    panel.setAttribute('aria-busy', 'true');
    requestAnimationFrame(() => {
      panel.removeAttribute('aria-busy');
      void announced;
    });
  }
  document.addEventListener('keydown', onEscape, true);

  // Never at render() entry: a delayed message landing in a backgrounded tab
  // would otherwise report an impression nobody saw, corrupting the denominator
  // of every rate in the channel.
  requestAnimationFrame(() => {
    if (closed || !host.isConnected) return;
    if (document.visibilityState !== 'visible') return;
    callbacks.onImpression();
  });

  function primaryAction(target: InAppMessage): void {
    const first = target.buttons[0];
    if (!first) {
      close('dismiss');
      return;
    }
    callbacks.onButton(first);
    close('button');
  }

  return { close, root };
}

function buildFigure(url: string, alt: string): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'figure';
  const image = document.createElement('img');
  image.src = url;
  image.alt = alt;
  image.loading = 'eager';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  // A dead image hides the figure and KEEPS the message — the headline and
  // buttons are the part that carries the offer.
  image.addEventListener('error', () => figure.remove());
  figure.append(image);
  return figure;
}

function buildImageOnly(
  message: InAppMessage,
  onActivate: () => void,
): HTMLElement {
  // A real <button> wrapper rather than a click handler on the image, so the
  // whole target is reachable by keyboard and announced as actionable.
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'image-only';
  const image = document.createElement('img');
  image.src = message.content.imageUrl ?? '';
  image.alt = message.content.headline;
  image.loading = 'eager';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  button.append(image);
  button.addEventListener('click', onActivate);
  return button;
}

function buildButtonRow(
  message: InAppMessage,
  callbacks: ViewCallbacks,
  close: (reason: 'dismiss' | 'button' | 'expired') => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'buttons';

  for (const button of message.buttons) {
    const element =
      button.action === 'URL' && safeDestination(button.value)
        ? buildLink(button)
        : buildButton(button);
    element.addEventListener('click', () => {
      // Enqueued BEFORE navigation: a link that unloads the page must already
      // have its click persisted, and the queue survives the unload.
      if (button.action !== 'DISMISS') callbacks.onButton(button);
      close(button.action === 'DISMISS' ? 'dismiss' : 'button');
      if (button.action === 'DEEP_LINK') {
        const destination = safeDestination(button.value);
        if (destination) location.assign(destination);
      }
    });
    row.append(element);
  }
  return row;
}

/**
 * Schemes that execute rather than navigate.
 *
 * The server validates button destinations on write, so this is the second
 * line: an SDK version older than that validation, or a bundle already stored
 * before it landed, still renders through here. Both sinks are guarded — an
 * `<a href>` and `location.assign` execute a `javascript:` URL alike.
 */
const EXECUTABLE_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'];

function safeDestination(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    // The browser's own parser, so we agree with it on the forms a regex
    // misses — leading whitespace, embedded newlines in the scheme.
    const url = new URL(value, location.href);
    return EXECUTABLE_SCHEMES.includes(url.protocol.toLowerCase())
      ? null
      : value;
  } catch {
    return null;
  }
}

function buildLink(button: InAppButton): HTMLElement {
  const link = document.createElement('a');
  link.href = safeDestination(button.value) ?? '#';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = `cta ${button.style.toLowerCase()}`;
  link.textContent = button.label;
  return link;
}

function buildButton(button: InAppButton): HTMLElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `cta ${button.style.toLowerCase()}`;
  element.textContent = button.label;
  return element;
}

function buildCloseButton(label: string, onClose: () => void): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'close';
  button.setAttribute('aria-label', label);
  // A cross drawn in text rather than an icon font or inline SVG: no external
  // fetch, no CSP surface, and it inherits the panel's colour.
  button.textContent = '×';
  button.addEventListener('click', onClose);
  return button;
}

/**
 * Cycles Tab within the dialog.
 *
 * Reads `root.activeElement`, NOT `document.activeElement`: under a closed
 * shadow root the latter resolves to the host element and the trap silently
 * does nothing at all.
 */
function trapFocus(event: KeyboardEvent, root: ShadowRoot): void {
  if (event.key !== 'Tab') return;
  const focusable = [
    ...root.querySelectorAll<HTMLElement>('button, a[href]'),
  ].filter((element) => !element.hasAttribute('disabled'));
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  const current = root.activeElement;

  if (event.shiftKey && current === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && current === last) {
    event.preventDefault();
    first.focus();
  }
}

function readDirection(): string {
  const explicit = document.documentElement.getAttribute('dir');
  if (explicit) return explicit;
  try {
    return getComputedStyle(document.documentElement).direction || 'ltr';
  } catch {
    return 'ltr';
  }
}

/**
 * Supplies the missing half of a colour pair.
 *
 * An author who set only a background would otherwise get the default text
 * colour on it, which is how a message ends up white-on-white and invisible
 * while still reporting a perfectly healthy impression.
 */
function resolveColors(message: InAppMessage): {
  background?: string;
  text?: string;
} {
  const background = HEX_COLOR.test(message.content.backgroundColor ?? '')
    ? message.content.backgroundColor
    : undefined;
  const text = HEX_COLOR.test(message.content.textColor ?? '')
    ? message.content.textColor
    : undefined;

  if (background && !text) {
    return { background, text: luminance(background) > LIGHT_LUMINANCE ? '#101010' : '#FFFFFF' };
  }
  return { background, text };
}

function luminance(hex: string): number {
  const value = hex.slice(1);
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value.slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * A constructed stylesheet rather than a `<style>` element wherever possible.
 *
 * A `<style>` inside a shadow root IS governed by the host page's `style-src`,
 * so a customer running `style-src 'self'` would get an unstyled message. A
 * constructed sheet is not markup and is not subject to it. The `<style>`
 * fallback stays for browsers without `adoptedStyleSheets` — and is the branch
 * that actually runs in most test DOMs.
 */
function applyStyles(root: ShadowRoot): void {
  if ('adoptedStyleSheets' in Document.prototype && typeof CSSStyleSheet === 'function') {
    try {
      sheet ??= buildSheet();
      root.adoptedStyleSheets = [sheet];
      return;
    } catch {
      // Constructable stylesheets unavailable despite the feature test.
    }
  }
  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  root.append(style);
}

function buildSheet(): CSSStyleSheet {
  const constructed = new CSSStyleSheet();
  constructed.replaceSync(CSS_TEXT);
  return constructed;
}

/**
 * `all: initial` MUST be the first declaration in `:host`.
 *
 * Everything before it in the same rule is wiped, and it resets `display` to
 * `inline` and drops `position` — so both are re-declared after it. Without it
 * the host page's `font-family`, `line-height`, `color`, `letter-spacing` and
 * `text-transform` all inherit straight through the shadow boundary.
 */
const CSS_TEXT = `
:host {
  all: initial;
  display: block;
  position: fixed;
  inset: 0;
  pointer-events: none;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  line-height: 1.5;
  color: #101010;
}
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: auto;
}
.panel {
  position: fixed;
  box-sizing: border-box;
  pointer-events: auto;
  background: #ffffff;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
}
:host([data-layout="MODAL"]) .panel {
  inset-inline-start: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(calc(100vw - 32px), 420px);
}
:host([dir="rtl"][data-layout="MODAL"]) .panel {
  transform: translate(50%, -50%);
}
:host([data-layout="BANNER_TOP"]) .panel,
:host([data-layout="BANNER_BOTTOM"]) .panel {
  inset-inline: 16px;
  margin-inline: auto;
  max-width: min(calc(100vw - 32px), 560px);
}
:host([data-layout="BANNER_TOP"]) .panel {
  top: 16px;
  padding-top: calc(20px + env(safe-area-inset-top));
}
:host([data-layout="BANNER_BOTTOM"]) .panel {
  bottom: 16px;
  padding-bottom: calc(20px + env(safe-area-inset-bottom));
}
:host([data-layout="IMAGE_ONLY"]) .panel {
  inset-inline-start: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 0;
  background: transparent;
  box-shadow: none;
}
.figure { margin: 0 0 12px; }
.figure img, .image-only img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 8px;
}
.image-only {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  width: min(calc(100vw - 32px), 420px);
}
.headline { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
.body { margin: 0 0 16px; font-size: 15px; }
.buttons { display: flex; gap: 8px; flex-wrap: wrap; }
.cta {
  flex: 1 1 auto;
  min-height: ${MIN_TAP_TARGET_PX}px;
  padding: 10px 16px;
  border-radius: 8px;
  border: 1px solid currentColor;
  font: inherit;
  cursor: pointer;
  text-align: center;
  text-decoration: none;
}
.cta.primary { background: #101010; color: #ffffff; border-color: #101010; }
.cta.secondary { background: transparent; color: inherit; }
.close {
  position: absolute;
  top: 4px;
  inset-inline-end: 4px;
  min-width: ${MIN_TAP_TARGET_PX}px;
  min-height: ${MIN_TAP_TARGET_PX}px;
  border: 0;
  background: none;
  color: inherit;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
@media (prefers-reduced-motion: reduce) {
  .panel { animation: none; transition: none; }
}
`;
