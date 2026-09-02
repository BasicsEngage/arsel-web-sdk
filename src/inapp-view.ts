import type { InAppButton, InAppField, InAppMessage } from './inapp';

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
/** Matches DEFAULT_IN_APP_RATING_SCALE on the server. */
const DEFAULT_RATING_SCALE = 5;
/** Bounds on anything crossing the bridge from untrusted markup. */
const MAX_BRIDGE_FIELDS = 20;
const MAX_BRIDGE_KEY_CHARS = 64;
const MAX_BRIDGE_VALUE_CHARS = 500;
const MIN_SANDBOX_HEIGHT_PX = 80;
/** A frame may not grow past this share of the viewport, whatever it asks for. */
const MAX_SANDBOX_VIEWPORT_SHARE = 0.9;
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
  /** Answers keyed by `fieldId`. Only ever called for FORM and RATING. */
  onSubmit(submission: Record<string, string>): void;
  /** A custom-HTML message asked to record an event of its own. */
  onCustomEvent(name: string, properties: Record<string, string | number | boolean>): void;
  onDismiss(visibleSeconds: number): void;
}

export interface ViewHandle {
  close(reason: 'dismiss' | 'button' | 'expired'): void;
  /** Internal test seam. Never re-exported from the public entry point. */
  readonly root: ShadowRoot;
}

/**
 * Layouts that overlay the page and therefore behave as dialogs: they get a
 * backdrop, `role="dialog"`, and a focus trap. Banners deliberately do not —
 * a strip at the edge of the page must never steal focus from a visitor who
 * is mid-form. IMAGE_ONLY is centred but has no text to label a dialog with.
 */
const DIALOG_LAYOUTS: readonly string[] = [
  'MODAL',
  'HALF_INTERSTITIAL',
  'ALERT',
  'FORM',
  'RATING',
  'CUSTOM_HTML',
];

/** Layouts that collect answers, and so render inputs instead of a bare panel. */
const INPUT_LAYOUTS: readonly string[] = ['FORM', 'RATING'];

/** ALERT is the OS-alert shape: text and actions only, never an image. */
const IMAGELESS_LAYOUTS: readonly string[] = ['ALERT'];

export function render(
  message: InAppMessage,
  options: ViewOptions,
  callbacks: ViewCallbacks,
): ViewHandle {
  const isModal = DIALOG_LAYOUTS.includes(message.layout);
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
  // Listeners that outlive the panel's own nodes and so are not collected by
  // removing the host — today only the custom-HTML bridge.
  const teardowns: (() => void)[] = [];
  const close = (reason: 'dismiss' | 'button' | 'expired'): void => {
    if (closed) return;
    closed = true;
    for (const dispose of teardowns) dispose();
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

  const custom = message.layout === 'CUSTOM_HTML' ? message.customHtml : null;

  if (custom) {
    panel.classList.add('panel--custom');
    // The headline is never drawn for this layout — the markup owns everything
    // visible — but it still has to name the dialog, because the frame's
    // contents are opaque to the host and an unnamed dialog is unusable with a
    // screen reader.
    panel.setAttribute('aria-label', message.content.headline);
    panel.removeAttribute('aria-labelledby');
    panel.removeAttribute('aria-describedby');
    panel.append(buildSandbox(custom, message, callbacks, close, teardowns));
  } else if (message.layout === 'IMAGE_ONLY' && message.content.imageUrl) {
    panel.append(buildImageOnly(message, () => primaryAction(message)));
  } else {
    if (message.content.imageUrl && !IMAGELESS_LAYOUTS.includes(message.layout)) {
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

  const collectsInput =
    INPUT_LAYOUTS.includes(message.layout) && message.fields.length > 0;
  const readAnswers = collectsInput
    ? buildFieldSet(message, panel, uid)
    : null;

  if (message.buttons.length > 0) {
    panel.append(
      buildButtonRow(message, callbacks, close, readAnswers ?? undefined),
    );
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
    backdrop.className =
      custom?.overlayStyle === 'TRANSPARENT' ? 'backdrop clear' : 'backdrop';
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

/**
 * Draws the message's inputs and returns a reader for their answers.
 *
 * The reader returns null when a required field is unanswered, having focused
 * the first offender — validation lives here rather than in the caller so the
 * button row does not need to know what a field is. Answers come back keyed by
 * `fieldId`; the SDK never receives a destination, so it cannot send one.
 */
/**
 * Renders author-supplied markup inside a null-origin iframe.
 *
 * This is the only place the SDK draws content it did not construct, and the sandbox is the whole
 * of the security design. `allow-scripts` WITHOUT `allow-same-origin` gives the frame an opaque
 * origin: script runs, but it cannot read the host page's DOM, cookies or storage, and cannot make
 * same-origin requests back to the customer's site. The two are never granted together — that
 * combination lets a frame strip its own sandbox attribute, which is the same as no sandbox at all.
 *
 * Withheld deliberately: `allow-top-navigation`, so the markup cannot redirect the customer's site
 * out from under the visitor; and `allow-popups`, `allow-modals`, `allow-forms`. The frame reaches
 * the page only through the bridge below.
 *
 * When the author did not enable JavaScript the sandbox is left fully restricted and the frame is
 * inert markup — a far smaller surface, and enough for most creatives.
 */
function buildSandbox(
  custom: NonNullable<InAppMessage['customHtml']>,
  message: InAppMessage,
  callbacks: ViewCallbacks,
  close: (reason: 'dismiss' | 'button' | 'expired') => void,
  teardowns: (() => void)[],
): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.className = 'sandbox';
  frame.title = message.content.headline;
  frame.setAttribute('sandbox', custom.allowJavaScript ? 'allow-scripts' : '');
  // Belt and braces with the sandbox: a frame that somehow ran script still
  // gets nothing from the browser's own permission surface.
  frame.setAttribute('allow', '');
  frame.referrerPolicy = 'no-referrer';

  if (custom.source === 'URL' && custom.url) {
    frame.src = custom.url;
  } else if (custom.html) {
    // srcdoc rather than a blob: URL — a blob inherits the creating origin,
    // which would undo the opaque origin the sandbox exists to create.
    frame.srcdoc = custom.html;
  }

  if (custom.allowJavaScript) {
    teardowns.push(attachBridge(frame, message, callbacks, close));
  }
  return frame;
}

/**
 * The only channel from the markup back to the SDK, and the reason the frame needs no privileges.
 *
 * Every message is checked against the frame's own window before it is read, so another frame, the
 * host page, or an extension cannot forge one — an origin check would be worthless here, because a
 * sandboxed frame's origin is the string "null" and every such frame shares it.
 *
 * Nothing from the frame is evaluated, written into the page, or followed as a destination. A
 * button is named by id and resolved against the CAMPAIGN's own buttons, so the frame can ask for
 * an action the author defined but can never invent one — the same rule that keeps `fieldKey` off
 * the wire for forms.
 *
 * Returns its own disposer: a listener that outlived its frame would keep the whole view alive and
 * would answer whichever frame next occupied the window.
 */
function attachBridge(
  frame: HTMLIFrameElement,
  message: InAppMessage,
  callbacks: ViewCallbacks,
  close: (reason: 'dismiss' | 'button' | 'expired') => void,
): () => void {
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return;
    if (!isBridgeMessage(event.data)) return;
    const payload = event.data;

    switch (payload.type) {
      case 'arsel:dismiss':
        close('dismiss');
        return;
      case 'arsel:track': {
        const name = typeof payload.event === 'string' ? payload.event.trim() : '';
        if (!name) return;
        callbacks.onCustomEvent(
          name.slice(0, MAX_BRIDGE_KEY_CHARS),
          readBridgeProperties(payload.properties),
        );
        return;
      }
      case 'arsel:button': {
        const button = message.buttons.find(
          (candidate) => candidate.buttonId === payload.buttonId,
        );
        if (button) activateButton(button, callbacks, close);
        return;
      }
      case 'arsel:submit': {
        const answers = readBridgeSubmission(payload.submission);
        if (answers) callbacks.onSubmit(answers);
        return;
      }
      case 'arsel:resize':
        resizeSandbox(frame, payload.height);
        return;
      default:
        return;
    }
  };

  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/**
 * Runs a campaign-defined button asked for by the frame.
 *
 * The button row does not go through here: there a URL action is a real `<a target="_blank">`, so
 * the browser navigates and no script has to. From the bridge there is no anchor, and a popup
 * opened out of a message handler carries no user gesture — so a blocked `window.open` falls back
 * to the current tab rather than silently doing nothing.
 */
function activateButton(
  button: InAppButton,
  callbacks: ViewCallbacks,
  close: (reason: 'dismiss' | 'button' | 'expired') => void,
): void {
  // Enqueued before any navigation: the queue survives an unload, the click
  // handler does not.
  if (button.action !== 'DISMISS') callbacks.onButton(button);
  const destination =
    button.action === 'URL' || button.action === 'DEEP_LINK'
      ? safeDestination(button.value)
      : null;

  close(button.action === 'DISMISS' ? 'dismiss' : 'button');
  if (!destination) return;

  if (button.action === 'DEEP_LINK') {
    location.assign(destination);
    return;
  }
  const opened = window.open(destination, '_blank', 'noopener,noreferrer');
  if (!opened) location.assign(destination);
}

/**
 * Honours a height the frame asks for, clamped.
 *
 * Without this a custom message is stuck at whatever default the CSS picked, because a null-origin
 * frame's content height is unreadable from the host. The clamp is what makes obeying it safe: an
 * unbounded height is a full-page overlay the visitor cannot scroll past.
 */
function resizeSandbox(frame: HTMLIFrameElement, requested: unknown): void {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return;
  const ceiling = window.innerHeight * MAX_SANDBOX_VIEWPORT_SHARE;
  const height = Math.min(Math.max(requested, MIN_SANDBOX_HEIGHT_PX), ceiling);
  frame.style.setProperty('height', `${Math.round(height)}px`);
}

interface BridgeMessage {
  type: string;
  event?: unknown;
  properties?: unknown;
  buttonId?: unknown;
  submission?: unknown;
  height?: unknown;
}

function isBridgeMessage(value: unknown): value is BridgeMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/**
 * Properties on a frame-authored event, bounded and flattened.
 *
 * Unlike a submission — which is refused outright when malformed, because a half-read set of
 * answers is worse than none — a bad property is simply dropped and the event still records. The
 * event is the thing being reported; losing it because one value was an object would hide the
 * interaction entirely.
 *
 * Nested values are not serialised. The queue posts these to an API that types properties as
 * primitives, and quietly JSON-encoding an object would put a string where a number is expected in
 * every segment that reads it.
 */
function readBridgeProperties(
  value: unknown,
): Record<string, string | number | boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const properties: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(properties).length >= MAX_BRIDGE_FIELDS) break;
    if (!key || key.length > MAX_BRIDGE_KEY_CHARS) continue;

    if (typeof raw === 'string') {
      properties[key] = raw.slice(0, MAX_BRIDGE_VALUE_CHARS);
    } else if (typeof raw === 'boolean') {
      properties[key] = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      properties[key] = raw;
    }
  }
  return properties;
}

/**
 * Bounded before it reaches the queue. The frame is untrusted, so a submission of arbitrary size or
 * shape is refused here rather than enqueued and rejected a round trip later.
 */
function readBridgeSubmission(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_BRIDGE_FIELDS) return null;

  const answers: Record<string, string> = {};
  for (const [key, answer] of entries) {
    if (typeof answer !== 'string') return null;
    if (!key || key.length > MAX_BRIDGE_KEY_CHARS) return null;
    answers[key] = answer.slice(0, MAX_BRIDGE_VALUE_CHARS);
  }
  return answers;
}

function buildFieldSet(
  message: InAppMessage,
  panel: HTMLElement,
  uid: string,
): () => Record<string, string> | null {
  const wrapper = document.createElement('div');
  wrapper.className = 'fields';

  const readers: {
    field: InAppField;
    read: () => string;
    focus: () => void;
  }[] = [];

  message.fields.forEach((field, index) => {
    const fieldUid = `${uid}-f${index}`;
    const group = document.createElement('div');
    group.className = 'field';

    if (field.type !== 'checkbox') {
      const label = document.createElement('label');
      label.className = 'field-label';
      label.htmlFor = fieldUid;
      label.textContent = field.required ? `${field.label} *` : field.label;
      group.append(label);
    }

    const control = buildControl(field, fieldUid);
    group.append(control.element);
    wrapper.append(group);
    readers.push({ field, read: control.read, focus: control.focus });
  });

  panel.append(wrapper);

  return () => {
    const answers: Record<string, string> = {};
    let firstInvalid: (() => void) | null = null;

    for (const entry of readers) {
      const value = entry.read();
      if (!value) {
        if (entry.field.required && !firstInvalid) firstInvalid = entry.focus;
        continue;
      }
      answers[entry.field.fieldId] = value;
    }

    if (firstInvalid) {
      firstInvalid();
      return null;
    }
    return answers;
  };
}

interface FieldControl {
  element: HTMLElement;
  /** Empty string means "not answered", whatever the control. */
  read: () => string;
  focus: () => void;
}

function buildControl(field: InAppField, fieldUid: string): FieldControl {
  if (field.type === 'rating') return buildRating(field, fieldUid);
  if (field.type === 'checkbox') return buildCheckbox(field, fieldUid);
  if (field.type === 'dropdown') return buildDropdown(field, fieldUid);
  if (field.type === 'radio') return buildRadio(field, fieldUid);
  return buildTextInput(field, fieldUid);
}

/**
 * Radio inputs rather than clickable spans: a rating is a single-choice
 * control, and the native element brings the keyboard support and the
 * screen-reader semantics that a div cannot be given cheaply.
 */
function buildRating(field: InAppField, fieldUid: string): FieldControl {
  const scale =
    field.scale && field.scale > 1 ? field.scale : DEFAULT_RATING_SCALE;
  const group = document.createElement('div');
  group.className = 'rating';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', field.label);

  let selected = '';
  const inputs: HTMLInputElement[] = [];

  for (let value = 1; value <= scale; value += 1) {
    const option = document.createElement('label');
    option.className = 'rating-option';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = fieldUid;
    input.value = String(value);
    input.className = 'rating-input';
    input.setAttribute('aria-label', String(value));
    input.addEventListener('change', () => {
      selected = input.value;
      group.setAttribute('data-selected', selected);
    });

    const face = document.createElement('span');
    face.className = 'rating-face';
    // Stars up to 5, numerals beyond: a ten-star row is unreadable at the
    // width a message gets, and NPS is conventionally numeric anyway.
    face.textContent = scale <= 5 ? '★' : String(value);

    option.append(input, face);
    group.append(option);
    inputs.push(input);
  }

  return {
    element: group,
    read: () => selected,
    focus: () => inputs[0]?.focus(),
  };
}

function buildTextInput(field: InAppField, fieldUid: string): FieldControl {
  const input = document.createElement('input');
  input.id = fieldUid;
  input.className = 'field-input';
  input.type =
    field.type === 'email' ? 'email' : field.type === 'tel' ? 'tel' : 'text';
  if (field.placeholder) input.placeholder = field.placeholder;
  if (field.required) input.required = true;

  return {
    element: input,
    read: () => input.value.trim(),
    focus: () => input.focus(),
  };
}

function buildCheckbox(field: InAppField, fieldUid: string): FieldControl {
  const wrapper = document.createElement('label');
  wrapper.className = 'field-check';

  const input = document.createElement('input');
  input.id = fieldUid;
  input.type = 'checkbox';

  const text = document.createElement('span');
  text.textContent = field.required ? `${field.label} *` : field.label;

  wrapper.append(input, text);

  return {
    element: wrapper,
    // A required checkbox must be ticked, so an unticked one reads as empty
    // rather than as "false" — otherwise a consent box would pass validation
    // while recording a refusal.
    read: () => (input.checked ? 'true' : field.required ? '' : 'false'),
    focus: () => input.focus(),
  };
}

function buildDropdown(field: InAppField, fieldUid: string): FieldControl {
  const select = document.createElement('select');
  select.id = fieldUid;
  select.className = 'field-input';

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = field.placeholder ?? 'Choose…';
  select.append(blank);

  for (const option of field.options ?? []) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    select.append(element);
  }

  return {
    element: select,
    read: () => select.value,
    focus: () => select.focus(),
  };
}

function buildRadio(field: InAppField, fieldUid: string): FieldControl {
  const group = document.createElement('div');
  group.className = 'field-radios';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', field.label);

  let selected = '';
  const inputs: HTMLInputElement[] = [];

  (field.options ?? []).forEach((option, index) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'field-check';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = fieldUid;
    input.value = option.value;
    if (index === 0) input.id = fieldUid;
    input.addEventListener('change', () => {
      selected = input.value;
    });

    const text = document.createElement('span');
    text.textContent = option.label;

    wrapper.append(input, text);
    group.append(wrapper);
    inputs.push(input);
  });

  return {
    element: group,
    read: () => selected,
    focus: () => inputs[0]?.focus(),
  };
}

function buildButtonRow(
  message: InAppMessage,
  callbacks: ViewCallbacks,
  close: (reason: 'dismiss' | 'button' | 'expired') => void,
  readAnswers?: () => Record<string, string> | null,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'buttons';

  for (const button of message.buttons) {
    const element =
      button.action === 'URL' && safeDestination(button.value)
        ? buildLink(button)
        : buildButton(button);
    element.addEventListener('click', (event) => {
      // A form's non-dismiss button submits. Answers are read BEFORE close(),
      // which detaches the inputs — and a failed validation aborts the click
      // entirely, so the message stays open with the problem visible.
      if (readAnswers && button.action !== 'DISMISS') {
        const answers = readAnswers();
        if (!answers) {
          event.preventDefault();
          return;
        }
        callbacks.onSubmit(answers);
      }
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
:host([data-layout="HALF_INTERSTITIAL"]) .panel {
  inset-inline: 16px;
  bottom: 0;
  margin-inline: auto;
  width: min(calc(100vw - 32px), 480px);
  max-height: 60vh;
  border-end-start-radius: 0;
  border-end-end-radius: 0;
  padding-bottom: calc(20px + env(safe-area-inset-bottom));
}
:host([data-layout="ALERT"]) .panel {
  inset-inline-start: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(calc(100vw - 64px), 320px);
  text-align: center;
}
:host([dir="rtl"][data-layout="ALERT"]) .panel {
  transform: translate(50%, -50%);
}
:host([data-layout="FORM"]) .panel,
:host([data-layout="RATING"]) .panel {
  inset-inline-start: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(calc(100vw - 32px), 400px);
}
:host([dir="rtl"][data-layout="FORM"]) .panel,
:host([dir="rtl"][data-layout="RATING"]) .panel {
  transform: translate(50%, -50%);
}
.fields { display: flex; flex-direction: column; gap: 12px; margin: 12px 0 4px; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 13px; font-weight: 500; }
.field-input {
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: 1px solid rgba(127, 127, 127, 0.5);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  box-sizing: border-box;
}
.field-check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.field-radios { display: flex; flex-direction: column; gap: 6px; }
.rating { display: flex; justify-content: center; gap: 4px; }
.rating-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 36px;
  min-height: 36px;
  cursor: pointer;
}
/* Visually hidden, never display:none — the latter removes it from the
   accessibility tree and from keyboard focus, which is the whole point of
   using a real radio here. */
.rating-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.rating-face { font-size: 24px; line-height: 1; opacity: 0.35; }
.rating-input:checked ~ .rating-face,
.rating-option:hover .rating-face { opacity: 1; }
.rating-input:focus-visible ~ .rating-face { outline: 2px solid currentColor; outline-offset: 2px; }
:host([data-layout="CUSTOM_HTML"]) .panel {
  inset-inline-start: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(calc(100vw - 32px), 420px);
  padding: 0;
  background: transparent;
  overflow: hidden;
}
:host([dir="rtl"][data-layout="CUSTOM_HTML"]) .panel {
  transform: translate(50%, -50%);
}
.backdrop.clear { background: transparent; }
.sandbox {
  display: block;
  width: 100%;
  height: 420px;
  max-height: calc(100vh - 32px);
  border: 0;
  background: transparent;
}
.panel--custom .buttons { padding: 12px; }
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
