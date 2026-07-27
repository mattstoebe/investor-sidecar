import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Exercises the real content-script driver (public/scripts/content.js) in jsdom, the same
 * way site-adapters.test.ts exercises the adapters: the shipped file is evaluated, not
 * mirrored, so these assertions can't drift from what ships.
 *
 * The driver had no tests, which is how the click-interception bug survived -- the wiring
 * looked right and only misbehaved against a specific DOM ancestry that no test described.
 */

interface InjectionTarget {
  container: Element | null;
  insertAfter?: Element | null;
  position?: 'append' | 'prepend';
}

interface Driver {
  injectInto(target: InjectionTarget, button: Element): boolean;
  createCalculatorElement(
    handler: () => unknown,
    options?: { className?: string; label?: string }
  ): HTMLElement;
  ensureCalculatorStyles(): void;
  ensureCalculatorOnDetailPage(): void;
}

/**
 * content.js ends by calling init(), which needs an adapter for the current hostname and
 * would install a MutationObserver we don't want here. Loading only the declarations up to
 * that call keeps the unit under test to the injection and event logic.
 */
function loadDriver(siteStub?: Record<string, unknown>): Driver {
  const source = readFileSync(resolve(__dirname, '../public/scripts/content.js'), 'utf8');
  const withoutBootstrap = source.replace(/\ninit\(\);\s*$/, '\n');
  // `site` is resolved once at load from the adapter list. Overriding it after the fact is
  // how a specific adapter shape gets tested without a matching hostname.
  const withSiteOverride = siteStub
    ? withoutBootstrap.replace(
        /^const site = .*$/m,
        'const site = globalThis.__siteStub;'
      )
    : withoutBootstrap;
  if (siteStub) (globalThis as Record<string, unknown>).__siteStub = siteStub;
  const factory = new Function(
    'chrome',
    'RedfinAdapter',
    'ZillowAdapter',
    `${withSiteOverride}; return { injectInto, createCalculatorElement, ensureCalculatorStyles, ensureCalculatorOnDetailPage };`
  );
  // The driver registers a runtime message listener at load and messages the worker on
  // capture; neither is the subject here. The adapters are real files loaded separately by
  // the manifest -- this suite covers the driver, so a host-matching stub is enough.
  const chromeStub = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async () => ({ ok: true, added: true })
    }
  };
  const adapterStub = { matchesHost: () => false };
  return factory(chromeStub, adapterStub, adapterStub) as Driver;
}

let driver: Driver;

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  driver = loadDriver();
});

describe('injectInto', () => {
  it('appends by default', () => {
    document.body.innerHTML = '<div id="row"><span id="first">a</span><span id="last">b</span></div>';
    const row = document.getElementById('row')!;
    const button = driver.createCalculatorElement(() => ({ ok: true }));

    expect(driver.injectInto({ container: row }, button)).toBe(true);
    expect(row.lastElementChild).toBe(button);
  });

  // The narrow-viewport fix: Redfin's action row overflows rather than wrapping, so an
  // appended button sat past the right edge of the page with no way to reach it.
  it('prepends when asked, so the button leads an overflowing row', () => {
    document.body.innerHTML = '<div id="row"><span id="first">a</span><span id="last">b</span></div>';
    const row = document.getElementById('row')!;
    const button = driver.createCalculatorElement(() => ({ ok: true }));

    expect(driver.injectInto({ container: row, insertAfter: null, position: 'prepend' }, button)).toBe(true);
    expect(row.firstElementChild).toBe(button);
  });

  it('places the button directly after a named sibling', () => {
    document.body.innerHTML = '<div id="row"><span id="save">save</span><span id="share">share</span></div>';
    const row = document.getElementById('row')!;
    const save = document.getElementById('save')!;
    const button = driver.createCalculatorElement(() => ({ ok: true }));

    driver.injectInto({ container: row, insertAfter: save }, button);
    expect(save.nextElementSibling).toBe(button);
  });

  // A mismatched pair used to silently append; keep that, but prove it rather than assume.
  it('falls back to appending when insertAfter is not a child of container', () => {
    document.body.innerHTML = '<div id="row"><span id="a">a</span></div><span id="stranger">x</span>';
    const row = document.getElementById('row')!;
    const button = driver.createCalculatorElement(() => ({ ok: true }));

    driver.injectInto({ container: row, insertAfter: document.getElementById('stranger') }, button);
    expect(row.lastElementChild).toBe(button);
  });

  it('refuses to add a second button to the same container', () => {
    document.body.innerHTML = '<div id="row"></div>';
    const row = document.getElementById('row')!;
    driver.injectInto({ container: row }, driver.createCalculatorElement(() => ({ ok: true })));

    expect(driver.injectInto({ container: row }, driver.createCalculatorElement(() => ({ ok: true })))).toBe(false);
    expect(row.querySelectorAll('.bp-CalculatorExtension')).toHaveLength(1);
  });

  it('does nothing without a container', () => {
    const button = driver.createCalculatorElement(() => ({ ok: true }));
    expect(driver.injectInto({ container: null }, button)).toBe(false);
  });
});

describe('button click interception', () => {
  /**
   * Reproduces Zillow's results card: the whole card is wrapped in the listing link, so our
   * button is a descendant of an <a>. This is the ancestry the old wiring failed on.
   */
  const renderInsideLink = () => {
    document.body.innerHTML = `
      <a id="card" href="/homedetails/123_zpid/">
        <div id="actions"><button id="save">Save</button></div>
      </a>
    `;
    return document.getElementById('actions')!;
  };

  const clickOn = (el: Element) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };

  it('runs the capture handler when the button is clicked', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const button = driver.createCalculatorElement(handler);
    renderInsideLink().appendChild(button);

    clickOn(button);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });

  // The actual bug: clicking Analyze on Zillow captured the house *and* opened the listing.
  it('cancels the click so an ancestor link cannot navigate', () => {
    const button = driver.createCalculatorElement(() => ({ ok: true }));
    renderInsideLink().appendChild(button);

    expect(clickOn(button).defaultPrevented).toBe(true);
  });

  /**
   * The old listeners were registered on the button, which is the *end* of the capture
   * path -- an ancestor's capture handler had already run by then. These are on document,
   * so nothing between document and the button ever sees the event.
   */
  it('stops the event before any ancestor handler sees it, in either phase', () => {
    const capture = vi.fn();
    const bubble = vi.fn();
    const button = driver.createCalculatorElement(() => ({ ok: true }));
    const actions = renderInsideLink();
    actions.appendChild(button);

    const card = document.getElementById('card')!;
    card.addEventListener('click', capture, true);
    card.addEventListener('click', bubble, false);

    clickOn(button);
    expect(capture).not.toHaveBeenCalled();
    expect(bubble).not.toHaveBeenCalled();
  });

  it('intercepts a click that lands on the icon inside the button, not the button itself', () => {
    const handler = vi.fn(() => ({ ok: true }));
    const button = driver.createCalculatorElement(handler);
    renderInsideLink().appendChild(button);

    const icon = button.querySelector('svg')!;
    expect(clickOn(icon).defaultPrevented).toBe(true);
  });

  /**
   * pointerup, not just mouseup: Pointer Events fire ahead of their compatibility mouse
   * events, so a router listening on pointerup navigates before a mouseup handler could
   * stop it. mouseup was covered before this change and pointerup was not.
   */
  it.each(['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick'])(
    'cancels %s on the button',
    (type) => {
      const button = driver.createCalculatorElement(() => ({ ok: true }));
      renderInsideLink().appendChild(button);

      const event = new Event(type, { bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  );

  it('cancels touch events, which are passive by default at document level', () => {
    const button = driver.createCalculatorElement(() => ({ ok: true }));
    renderInsideLink().appendChild(button);

    for (const type of ['touchstart', 'touchend']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented, `${type} should be cancelled`).toBe(true);
    }
  });

  it('leaves the page\'s own controls alone', () => {
    const handler = vi.fn(() => ({ ok: true }));
    const button = driver.createCalculatorElement(handler);
    const actions = renderInsideLink();
    actions.appendChild(button);

    const save = document.getElementById('save')!;
    expect(clickOn(save).defaultPrevented).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('activates on Enter and Space for keyboard users', async () => {
    for (const key of ['Enter', ' ']) {
      document.body.innerHTML = '';
      const handler = vi.fn(() => ({ ok: true }));
      const button = driver.createCalculatorElement(handler);
      renderInsideLink().appendChild(button);

      button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(handler, `${key} should activate`).toHaveBeenCalledTimes(1));
    }
  });

  it('ignores other keys', () => {
    const handler = vi.fn(() => ({ ok: true }));
    const button = driver.createCalculatorElement(handler);
    renderInsideLink().appendChild(button);

    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('will not run two captures at once while one is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    const handler = vi.fn(() => new Promise((r) => { release = r; }));
    const button = driver.createCalculatorElement(handler as unknown as () => unknown);
    renderInsideLink().appendChild(button);

    clickOn(button);
    await vi.waitFor(() => expect(button.dataset.busy).toBe('true'));
    clickOn(button);
    expect(handler).toHaveBeenCalledTimes(1);

    release({ ok: true });
    await vi.waitFor(() => expect(button.dataset.busy).toBe('false'));
  });

  it('draws a failed capture on the button instead of logging it', async () => {
    const button = driver.createCalculatorElement(() => ({ ok: false, reason: 'Could not read this listing' }));
    renderInsideLink().appendChild(button);

    clickOn(button);
    await vi.waitFor(() => expect(button.dataset.state).toBe('error'));
    expect(button.getAttribute('title')).toBe('Could not read this listing');
  });

  it('reports a thrown error rather than leaving the button stuck', async () => {
    const button = driver.createCalculatorElement(() => { throw new Error('extension not responding'); });
    renderInsideLink().appendChild(button);

    clickOn(button);
    await vi.waitFor(() => expect(button.dataset.state).toBe('error'));
    expect(button.getAttribute('title')).toBe('extension not responding');
    expect(button.dataset.busy).toBe('false');
  });
});

describe('detail-page injection', () => {
  const detailSite = (target: () => InjectionTarget | null) => ({
    isDetailPage: () => true,
    detailInjectionTarget: target,
    extractFromDetailPage: () => ({ propertyID: '1' }),
    detailButtonClassName: 'bp-CalculatorExtension sidecar-Button--action',
    detailWrapperClassName: 'sidecar-ActionWrapper',
    findCardElements: () => []
  });

  /**
   * Zillow's action bar is a <ul> of <li> items. A <div> wrapper dropped into it doesn't
   * participate in the row layout -- verified live: the button stacked underneath Save
   * rather than sitting beside it.
   */
  it('wraps the button in an li when injecting into the site\'s own action list', () => {
    document.body.innerHTML = `
      <ul id="links">
        <li id="save"><button aria-label="Save">Save</button></li>
        <li id="share"><button>Share</button></li>
      </ul>`;
    const links = document.getElementById('links')!;
    const d = loadDriver(detailSite(() => ({
      container: links,
      insertAfter: document.getElementById('save'),
      position: 'append'
    })));

    d.ensureCalculatorOnDetailPage();
    const button = document.querySelector('.bp-CalculatorExtension')!;
    const wrapper = button.parentElement!;
    expect(wrapper.tagName.toLowerCase()).toBe('li');
    // A peer of the Save item, immediately after it -- not inside it.
    expect(wrapper.parentElement).toBe(links);
    expect(document.getElementById('save')!.nextElementSibling).toBe(wrapper);
    expect(document.getElementById('save')!.contains(button)).toBe(false);
  });

  it('uses a div wrapper for an ordinary container', () => {
    document.body.innerHTML = '<div id="bar"></div>';
    const d = loadDriver(detailSite(() => ({ container: document.getElementById('bar') })));

    d.ensureCalculatorOnDetailPage();
    expect(document.querySelector('.bp-CalculatorExtension')!.parentElement!.tagName.toLowerCase())
      .toBe('div');
  });

  // Responsive layout moves the target; injecting into the new one without clearing the old
  // left a duplicate on every breakpoint swap, and dragging the panel divider sweeps through
  // those repeatedly.
  it('keeps exactly one button when the target moves', () => {
    document.body.innerHTML = '<div id="wide"></div><div id="narrow"></div>';
    let useWide = true;
    const d = loadDriver(detailSite(() =>
      ({ container: document.getElementById(useWide ? 'wide' : 'narrow') })));

    d.ensureCalculatorOnDetailPage();
    expect(document.querySelectorAll('.bp-CalculatorExtension')).toHaveLength(1);

    useWide = false;
    d.ensureCalculatorOnDetailPage();
    expect(document.querySelectorAll('.bp-CalculatorExtension')).toHaveLength(1);
    expect(document.getElementById('narrow')!.querySelector('.bp-CalculatorExtension')).not.toBeNull();
    expect(document.getElementById('wide')!.querySelector('.bp-CalculatorExtension')).toBeNull();
  });

  it('is a no-op when the page offers no target', () => {
    document.body.innerHTML = '<div></div>';
    const d = loadDriver(detailSite(() => null));
    d.ensureCalculatorOnDetailPage();
    expect(document.querySelectorAll('.bp-CalculatorExtension')).toHaveLength(0);
  });
});

describe('button appearance', () => {
  it('marks every node it creates as ours, so the observer can ignore its own output', () => {
    const button = driver.createCalculatorElement(() => ({ ok: true }), { label: 'Analyze' });
    expect(button.dataset.sidecar).toBe('1');
    for (const child of button.querySelectorAll('span')) {
      expect((child as HTMLElement).dataset.sidecar).toBe('1');
    }
  });

  it('is reachable and labelled for assistive tech', () => {
    const button = driver.createCalculatorElement(() => ({ ok: true }));
    expect(button.getAttribute('role')).toBe('button');
    expect(button.getAttribute('tabindex')).toBe('0');
    expect(button.getAttribute('aria-label')).toBe('Analyze with Investor Sidecar');
  });

  it('renders the label only when one is asked for', () => {
    expect(driver.createCalculatorElement(() => ({ ok: true })).querySelector('span')).toBeNull();
    const labelled = driver.createCalculatorElement(() => ({ ok: true }), { label: 'Analyze' });
    expect(labelled.querySelector('span')?.textContent).toBe('Analyze');
  });

  // The reported problem: the button read as a black circle, which sat out of alignment
  // with the plain icons in both sites' action rows.
  it('draws no circle or border on either variant', () => {
    driver.ensureCalculatorStyles();
    const css = document.getElementById('calculator-styles')!.textContent!;
    const variants = css.slice(css.indexOf('.sidecar-Button--icon'));
    expect(variants).toContain('border: 0');
    expect(variants).not.toContain('border-radius: 999px');
  });

  it('gives the button a stacking order, so a stretched card link cannot cover it', () => {
    driver.ensureCalculatorStyles();
    const css = document.getElementById('calculator-styles')!.textContent!;
    expect(css).toMatch(/\.bp-CalculatorExtension\s*\{[^}]*z-index/);
  });

  it('installs its stylesheet exactly once', () => {
    driver.ensureCalculatorStyles();
    driver.ensureCalculatorStyles();
    expect(document.querySelectorAll('#calculator-styles')).toHaveLength(1);
  });
});
