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
  ensureCalculatorOnCard(cardEl: Element): void;
  setCompSession(session: unknown): void;
  actionForListing(status: string, session: unknown): string;
  reconcileMapPins(): void;
  sweepMapPins(): void;
  setShowHousesOnMap(value: boolean): void;
  setStoredHousesForMap(houses: unknown[]): void;
  mapHouseKey(house: unknown): string;
  installMapPinInterceptors(): void;
  sendMessageCalls: Array<Record<string, unknown>>;
  StorageManager: {
    saveHouse(house: unknown): Promise<{ ok: boolean; reason?: string; added?: boolean }>;
  };
  buildComp(
    houseData: unknown,
    facts: unknown,
    session: unknown
  ): { ok: boolean; reason?: string; comp?: Record<string, unknown> };
}

/**
 * content.js ends by calling init(), which needs an adapter for the current hostname and
 * would install a MutationObserver we don't want here. Loading only the declarations up to
 * that call keeps the unit under test to the injection and event logic.
 *
 * Bundled with the real parsers.js, the same way site-adapters.test.ts bundles it with the
 * adapters -- content.js's comp-mode logic (buildComp, looksLikeRentalPrice) calls
 * SidecarParsers directly, and it's a separate content-script global in production, not an
 * import content.js's own source carries.
 */
function loadDriver(siteStub?: Record<string, unknown>): Driver {
  const parsersSource = readFileSync(resolve(__dirname, '../public/scripts/sites/parsers.js'), 'utf8');
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
    'HomesAdapter',
    `${parsersSource}\n${withSiteOverride}; return {
      injectInto, createCalculatorElement, ensureCalculatorStyles, ensureCalculatorOnDetailPage,
      ensureCalculatorOnCard, actionForListing,
      setCompSession: (s) => { compSession = s; },
      reconcileMapPins, sweepMapPins, mapHouseKey, installMapPinInterceptors,
      setShowHousesOnMap: (v) => { showHousesOnMap = v; },
      setStoredHousesForMap: (h) => { storedHousesForMap = h; },
      StorageManager, buildComp
    };`
  );
  // The driver registers a runtime message listener at load and messages the worker on
  // capture; neither is the subject here. The adapters are real files loaded separately by
  // the manifest -- this suite covers the driver, so a host-matching stub is enough.
  const sendMessageCalls: Array<Record<string, unknown>> = [];
  const chromeStub = {
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (message: Record<string, unknown>) => {
        sendMessageCalls.push(message);
        return { ok: true, added: true };
      },
      lastError: undefined as unknown
    }
  };
  const adapterStub = { matchesHost: () => false };
  const driver = factory(chromeStub, adapterStub, adapterStub, adapterStub) as Driver;
  driver.sendMessageCalls = sendMessageCalls;
  return driver;
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
   * path -- an ancestor's capture handler had already run by then. These are on window,
   * so nothing later in the capture path ever sees the event.
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

  it('runs before Zillow-style window routing registered after document_start', () => {
    const router = vi.fn();
    const button = driver.createCalculatorElement(() => ({ ok: true }));
    renderInsideLink().appendChild(button);
    window.addEventListener('click', router, { capture: true, once: true });

    clickOn(button);
    expect(router).not.toHaveBeenCalled();
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

describe('listing action policy', () => {
  const session = (kind: 'rent' | 'sold') => ({ kind });

  it.each([
    ['active', null, 'analyze'],
    ['sold', null, 'none'],
    ['rental', null, 'none'],
    ['unknown', null, 'none'],
    ['active', session('rent'), 'none'],
    ['sold', session('rent'), 'none'],
    ['rental', session('rent'), 'rent-comp'],
    ['active', session('sold'), 'sale-comp'],
    ['sold', session('sold'), 'sale-comp'],
    ['rental', session('sold'), 'none']
  ])('%s with %o resolves to %s', (status, compSession, expected) => {
    expect(driver.actionForListing(status as string, compSession)).toBe(expected);
  });
});

describe('card injection after async card hydration', () => {
  it('reconsiders a card that had no listing link on the first pass', () => {
    document.body.innerHTML = '<article id="card"></article>';
    const card = document.getElementById('card')!;
    const site = {
      id: 'zillow',
      isInjectableCard: (el: Element) => Boolean(el.querySelector('a[href*="/homedetails/"]')),
      extractFromCard: () => ({ propertyID: '1', price: '$2,225/mo', url: '/homedetails/x/1_zpid/' }),
      compFacts: () => ({ amountText: '$2,225/mo', priceLabel: null, soldDateText: '' }),
      cardInjectionTarget: (el: Element) => ({ container: el, insertAfter: null }),
      cardButtonClassName: 'bp-CalculatorExtension'
    };
    const d = loadDriver(site);
    d.setCompSession({ kind: 'rent', targetKey: 'zillow:9', subject: { address: '123 Main St' } });

    d.ensureCalculatorOnCard(card);
    expect(card.querySelector('.bp-CalculatorExtension')).toBeNull();

    card.innerHTML = '<a href="/homedetails/x/1_zpid/">Rental</a>';
    d.ensureCalculatorOnCard(card);
    expect(card.querySelector('.bp-CalculatorExtension')).not.toBeNull();
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

  it('withholds Analyze when an adapter identifies a rental detail page', () => {
    document.body.innerHTML = '<div id="bar"></div>';
    const d = loadDriver({
      ...detailSite(() => ({ container: document.getElementById('bar') })),
      isRentalDetailPage: () => true
    });
    d.ensureCalculatorOnDetailPage();
    expect(document.querySelector('.bp-CalculatorExtension')).toBeNull();
  });
});

/**
 * Outside comp mode, a rental listing's card is not a house to Analyze: its price is a
 * monthly rent, not a purchase price, and feeding "$4,500/mo" into the buy-and-hold
 * calculator as a $4,500 house was unreachable before comp mode sent anyone to a
 * rentals search at all -- reported live once it was.
 */
describe('card injection: rental listings outside comp mode', () => {
  const cardSite = (price: string) => ({
    id: 'redfin',
    isInjectableCard: () => true,
    extractFromCard: () => ({ propertyID: '1', price, url: '/home/1' }),
    cardInjectionTarget: (el: Element) => ({ container: el, insertAfter: null }),
    cardButtonClassName: 'bp-CalculatorExtension'
  });

  it('withholds the button on a card whose price is a monthly rent', () => {
    document.body.innerHTML = '<div id="card"></div>';
    const card = document.getElementById('card')!;
    const d = loadDriver(cardSite('$4,500/mo'));

    d.ensureCalculatorOnCard(card);
    expect(card.querySelector('.bp-CalculatorExtension')).toBeNull();
  });

  it('still injects normally on an ordinary for-sale card', () => {
    document.body.innerHTML = '<div id="card"></div>';
    const card = document.getElementById('card')!;
    const d = loadDriver(cardSite('$425,000'));

    d.ensureCalculatorOnCard(card);
    expect(card.querySelector('.bp-CalculatorExtension')).not.toBeNull();
  });

  it('injects the comp-mode button on the same rental card once a session is active', () => {
    document.body.innerHTML = '<div id="card"></div>';
    const card = document.getElementById('card')!;
    const d = loadDriver(cardSite('$4,500/mo'));
    d.setCompSession({ kind: 'rent', targetKey: 'redfin:1', subject: { address: '123 Main St' } });

    d.ensureCalculatorOnCard(card);
    const button = card.querySelector('.bp-CalculatorExtension');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-label')).toContain('Add as comp');
  });
});

/**
 * Both sites let the user flip For Sale / Sold / For Rent from the results page, and doing
 * so does not end an active comp session. Reported live: a sold session left on a for-rent
 * page happily accepted monthly rents as sale prices. The button is withheld rather than
 * left to refuse on click.
 */
describe('card injection: comp session kind must match the page', () => {
  const compCardSite = (price: string) => ({
    id: 'redfin',
    isInjectableCard: () => true,
    extractFromCard: () => ({ propertyID: '1', price, url: '/home/1' }),
    compFacts: () => ({ amountText: price, priceLabel: null, soldDateText: '' }),
    cardInjectionTarget: (el: Element) => ({ container: el, insertAfter: null }),
    cardButtonClassName: 'bp-CalculatorExtension'
  });

  const render = (price: string, kind: 'rent' | 'sold') => {
    document.body.innerHTML = '<div id="card"></div>';
    const card = document.getElementById('card')!;
    const d = loadDriver(compCardSite(price));
    d.setCompSession({ kind, targetKey: 'redfin:9', subject: { address: '123 Main St' } });
    d.ensureCalculatorOnCard(card);
    return card;
  };

  it('withholds the button on a rental card during a sold session', () => {
    expect(render('$4,500/mo', 'sold').querySelector('.bp-CalculatorExtension')).toBeNull();
  });

  it('withholds the button on a sold card during a rent session', () => {
    expect(render('$369,500', 'rent').querySelector('.bp-CalculatorExtension')).toBeNull();
  });

  it('injects when the card matches the session kind', () => {
    expect(render('$369,500', 'sold').querySelector('.bp-CalculatorExtension')).not.toBeNull();
    expect(render('$4,500/mo', 'rent').querySelector('.bp-CalculatorExtension')).not.toBeNull();
  });

  // An abbreviated sale price is still a sale price -- this is the shape that used to
  // parse as $1 and would now also have to survive the kind check.
  it('accepts an abbreviated sold price during a sold session', () => {
    expect(render('$1.10M', 'sold').querySelector('.bp-CalculatorExtension')).not.toBeNull();
  });

  it('still withholds the button on a multi-unit "from" price during a rent session', () => {
    expect(render('$1,200+/mo', 'rent').querySelector('.bp-CalculatorExtension')).toBeNull();
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

/**
 * The property-id guard. It exists because a non-numeric id used to be stored anyway and
 * every such house collided on one storage key, so all but the first were silently
 * discarded. Homes.com ids are alphanumeric, so the rule became adapter-declarable --
 * these cover both that it opens up for a site that needs it and, more importantly, that
 * it did not quietly open up for the two sites that don't.
 */
describe('property-id guard', () => {
  const alphanumericSite = {
    matchesHost: () => true,
    isValidPropertyId: (id: unknown) => /^[a-z0-9]{6,}$/i.test(String(id ?? ''))
  };

  it('rejects a non-numeric id for an adapter that declares no validator', async () => {
    const d = loadDriver({ matchesHost: () => true });
    const result = await d.StorageManager.saveHouse({ propertyID: 'vff9j5680b68l' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/identify this listing/i);
  });

  it('still accepts a bare-digit id for an adapter that declares no validator', async () => {
    const d = loadDriver({ matchesHost: () => true });
    expect((await d.StorageManager.saveHouse({ propertyID: '190123456' })).ok).toBe(true);
  });

  it('accepts an alphanumeric id when the adapter declares it valid', async () => {
    const d = loadDriver(alphanumericSite);
    expect((await d.StorageManager.saveHouse({ propertyID: 'vff9j5680b68l' })).ok).toBe(true);
  });

  it('rejects the empties the guard exists for, whichever rule is in force', async () => {
    for (const site of [{ matchesHost: () => true }, alphanumericSite]) {
      const d = loadDriver(site);
      for (const propertyID of [null, undefined, '', 'N/A']) {
        expect((await d.StorageManager.saveHouse({ propertyID })).ok, String(propertyID)).toBe(false);
      }
      expect((await d.StorageManager.saveHouse({})).ok).toBe(false);
    }
  });
});

/**
 * The comp path had two more copies of the digits-only id regex besides
 * StorageManager's, so an adapter that declared isValidPropertyId was still refused
 * there: isCompEligibleCard withheld the button outright and buildComp refused on click.
 * Homes.com ids are alphanumeric, so comps were dead for that site while ordinary
 * Analyze worked -- a split that only showed up as a missing button.
 */
describe('comp eligibility respects an adapter-declared id rule', () => {
  const compCardSite = (extra: Record<string, unknown>) => ({
    id: 'homes',
    isInjectableCard: () => true,
    extractFromCard: () => ({ propertyID: 'vff9j5680b68l', price: '$341,990', url: '/property/x/vff9j5680b68l/' }),
    compFacts: () => ({ amountText: '$341,990', priceLabel: 'Last List Price', soldDateText: 'Sold Mar 11, 2026' }),
    cardInjectionTarget: (el: Element) => ({ container: el, insertAfter: null }),
    cardButtonClassName: 'bp-CalculatorExtension',
    ...extra
  });

  const render = (extra: Record<string, unknown>) => {
    document.body.innerHTML = '<div id="card"></div>';
    const card = document.getElementById('card')!;
    const d = loadDriver(compCardSite(extra));
    d.setCompSession({ kind: 'sold', targetKey: 'homes:abc123def456', subject: { address: '123 Main St, Austin, TX 78745' } });
    d.ensureCalculatorOnCard(card);
    return card;
  };

  it('offers the comp button for an alphanumeric id when the adapter allows it', () => {
    const card = render({ isValidPropertyId: (id: unknown) => /^[a-z0-9]{6,}$/i.test(String(id ?? '')) });
    const button = card.querySelector('.bp-CalculatorExtension');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-label')).toContain('Add as comp');
  });

  it('withholds it when the adapter declares nothing, keeping the digits-only default', () => {
    expect(render({}).querySelector('.bp-CalculatorExtension')).toBeNull();
  });
});

/**
 * buildComp is the click-time gate, and it had its own copy of the id regex. The
 * injection-gate test above passes even with that copy restored -- the two paths are
 * genuinely independent, so both need covering.
 */
describe('buildComp respects an adapter-declared id rule', () => {
  const houseData = {
    source: 'homes',
    propertyID: 'vff9j5680b68l',
    address: '8111 Springsteen Dr, Austin, TX 78744',
    price: '$341,990',
    beds: '2',
    baths: '2',
    sqft: '1437',
    url: '/property/x/vff9j5680b68l/'
  };
  const facts = { amountText: '$341,990', priceLabel: 'Last List Price', soldDateText: 'Sold Mar 11, 2026' };
  const session = { kind: 'sold', targetKey: 'homes:abc123def456', subject: { address: '123 Main St, Austin, TX 78745' } };

  it('accepts an alphanumeric id when the adapter allows it', () => {
    const d = loadDriver({
      id: 'homes',
      isValidPropertyId: (id: unknown) => /^[a-z0-9]{6,}$/i.test(String(id ?? ''))
    });
    const result = d.buildComp(houseData, facts, session);
    expect(result.ok).toBe(true);
    expect(result.comp).toMatchObject({ propertyID: 'vff9j5680b68l', amount: 341990 });
  });

  it('refuses it when the adapter declares nothing', () => {
    const d = loadDriver({ id: 'homes' });
    const result = d.buildComp(houseData, facts, session);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/identify this listing from its card/i);
  });
});

/**
 * Map pins (docs/map-linking.md Option 3): content.js owns reconciling saved houses
 * against the current map, using whatever projection the site adapter hands back. These
 * tests stub the adapter's buildMapProjection/projectPoint/mapPinContainer entirely --
 * the real Redfin/Zillow projection math is covered in site-adapters.test.ts and
 * geo-projection.test.ts. What's under test here is the driver's own logic: the on/off
 * toggle, the viewport-membership filter, add/move/remove reconciliation, and the click
 * -> message wiring -- none of which depends on which site produced the projection.
 */
describe('map pins', () => {
  function mockRect(el: HTMLElement, rect: { width: number; height: number }) {
    el.getBoundingClientRect = () => ({
      left: 0, top: 0, right: rect.width, bottom: rect.height, x: 0, y: 0,
      width: rect.width, height: rect.height, toJSON() { return this; }
    });
  }

  function mapSite() {
    const container = document.createElement('div');
    mockRect(container, { width: 1000, height: 800 });
    document.body.appendChild(container);
    return {
      id: 'stub',
      mapPinContainer: () => container,
      // A trivial 1:1 "projection": lat/lon doubles as x/y, so tests can place a house
      // in or out of the container's rect just by choosing its coordinates.
      buildMapProjection: () => ({ container, fit: null }),
      projectPoint: (_projection: unknown, lat: number, lon: number) => ({ x: lat, y: lon })
    };
  }

  const houseA = { source: 'redfin', propertyID: 'A1', address: '1 Main St', latitude: 100, longitude: 100 };
  const houseB = { source: 'zillow', propertyID: 'B2', address: '2 Main St', latitude: 900, longitude: 700 };
  // Projects to (5000, 5000) -- outside the 1000x800 container plus margin.
  const houseOffscreen = { source: 'redfin', propertyID: 'C3', address: '3 Main St', latitude: 5000, longitude: 5000 };

  it('draws nothing and reports nothing while the toggle is off', () => {
    const site = mapSite();
    const d = loadDriver(site);
    d.setShowHousesOnMap(false);
    d.setStoredHousesForMap([houseA]);
    d.reconcileMapPins();

    expect(site.mapPinContainer().querySelectorAll('[data-sidecar-pin="1"]')).toHaveLength(0);
  });

  it('draws nothing for a site with no buildMapProjection (e.g. Homes.com, unsupported for now)', () => {
    const d = loadDriver({ id: 'homes' });
    d.setShowHousesOnMap(true);
    d.setStoredHousesForMap([houseA]);
    expect(() => d.reconcileMapPins()).not.toThrow();
  });

  it('places one pin per saved house with real coordinates inside the viewport', () => {
    const site = mapSite();
    const d = loadDriver(site);
    d.setShowHousesOnMap(true);
    d.setStoredHousesForMap([houseA, houseB]);
    d.reconcileMapPins();

    const pins = site.mapPinContainer().querySelectorAll('[data-sidecar-pin="1"]');
    expect(pins).toHaveLength(2);
  });

  it('skips a house with no coordinates', () => {
    const site = mapSite();
    const d = loadDriver(site);
    d.setShowHousesOnMap(true);
    d.setStoredHousesForMap([{ ...houseA, latitude: null, longitude: null }]);
    d.reconcileMapPins();

    expect(site.mapPinContainer().querySelectorAll('[data-sidecar-pin="1"]')).toHaveLength(0);
  });

  // The core of the off-viewport decision: never pan or zoom the site's own map to bring
  // a saved house into view (docs/map-linking.md, anti-bot posture) -- a house that
  // projects outside the container's own rect just gets no pin, silently.
  it('never draws a pin for a house that projects outside the map container', () => {
    const site = mapSite();
    const d = loadDriver(site);
    d.setShowHousesOnMap(true);
    d.setStoredHousesForMap([houseA, houseOffscreen]);
    d.reconcileMapPins();

    expect(site.mapPinContainer().querySelectorAll('[data-sidecar-pin="1"]')).toHaveLength(1);
    expect(d.mapHouseKey(houseOffscreen)).not.toBe(d.mapHouseKey(houseA));
  });

  it('moves an existing pin rather than recreating it when its house is reconciled again', () => {
    const site = mapSite();
    const d = loadDriver(site);
    d.setShowHousesOnMap(true);
    d.setStoredHousesForMap([houseA]);
    d.reconcileMapPins();
    const firstEl = site.mapPinContainer().querySelector('[data-sidecar-pin="1"]');

    d.setStoredHousesForMap([{ ...houseA, latitude: 200, longitude: 200 }]);
    d.reconcileMapPins();
    const secondEl = site.mapPinContainer().querySelector('[data-sidecar-pin="1"]');

    expect(secondEl).toBe(firstEl); // same node, moved
    expect((secondEl as HTMLElement).style.left).toBe('200px');
  });

  it('removes a pin whose house is no longer saved', () => {
    const site = mapSite();
    const d = loadDriver(site);
    d.setShowHousesOnMap(true);
    d.setStoredHousesForMap([houseA, houseB]);
    d.reconcileMapPins();
    expect(site.mapPinContainer().querySelectorAll('[data-sidecar-pin="1"]')).toHaveLength(2);

    d.setStoredHousesForMap([houseA]);
    d.reconcileMapPins();
    expect(site.mapPinContainer().querySelectorAll('[data-sidecar-pin="1"]')).toHaveLength(1);
  });

  it('sweeps every pin immediately when asked, regardless of the toggle', () => {
    const site = mapSite();
    const d = loadDriver(site);
    d.setShowHousesOnMap(true);
    d.setStoredHousesForMap([houseA]);
    d.reconcileMapPins();
    expect(site.mapPinContainer().querySelectorAll('[data-sidecar-pin="1"]')).toHaveLength(1);

    d.sweepMapPins();
    expect(site.mapPinContainer().querySelectorAll('[data-sidecar-pin="1"]')).toHaveLength(0);
  });

  it('reports how many of the saved houses with coordinates are currently shown', () => {
    const site = mapSite();
    const d = loadDriver(site);
    d.setShowHousesOnMap(true);
    d.setStoredHousesForMap([houseA, houseB, houseOffscreen]);
    d.reconcileMapPins();

    const status = d.sendMessageCalls.find((m) => m.action === 'mapPinStatus');
    expect(status).toMatchObject({ shown: 2, total: 3 });
  });

  it('sends mapPinClicked with the house key and swallows the click', () => {
    const site = mapSite();
    const d = loadDriver(site);
    d.installMapPinInterceptors();
    d.setShowHousesOnMap(true);
    d.setStoredHousesForMap([houseA]);
    d.reconcileMapPins();

    const pin = site.mapPinContainer().querySelector('[data-sidecar-pin="1"]')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    pin.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    const clicked = d.sendMessageCalls.find((m) => m.action === 'mapPinClicked');
    expect(clicked).toMatchObject({ key: d.mapHouseKey(houseA) });
  });

  it('does not intercept a click that lands outside any of our pins', () => {
    const site = mapSite();
    const d = loadDriver(site);
    d.installMapPinInterceptors();

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    site.mapPinContainer().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(d.sendMessageCalls.find((m) => m.action === 'mapPinClicked')).toBeUndefined();
  });
});
