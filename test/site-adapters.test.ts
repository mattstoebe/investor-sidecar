import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads the real adapter files (public/scripts/sites/*.js) into this jsdom
 * environment and runs them against DOM structures matching what was observed on
 * live pages. The adapters are plain content scripts, not modules, so they're
 * evaluated rather than imported -- but it is the shipped code being tested, not a
 * copy.
 *
 * The DOM shapes here are transcribed from live measurements:
 *  - Redfin card stats render as one unpunctuated string, "2 beds2 baths1,765 sq ft",
 *    verified identical to the old per-element extraction on 41/41 cards.
 *  - Redfin detail pages put abp-baths' value directly on the element ("6.5 ba")
 *    while abp-price/beds/sqFt wrap theirs in .statsValue.
 *  - Zillow detail facts render as "3beds2baths1,400sqft".
 */
function loadAdapters() {
  const read = (p: string) => readFileSync(resolve(__dirname, '../public/scripts/sites/', p), 'utf8');
  const bundle = [read('parsers.js'), read('geo-projection.js'), read('redfin.js'), read('zillow.js')].join(';\n');
  // Evaluated in this realm so the adapters see jsdom's document/window.
  const factory = new Function(`${bundle}; return { SidecarParsers, RedfinAdapter, ZillowAdapter };`);
  return factory() as {
    RedfinAdapter: SiteAdapter;
    ZillowAdapter: SiteAdapter;
  };
}

interface HouseData {
  source: string;
  address: string | null;
  price: string | null;
  beds: string | null;
  baths: string | null;
  sqft: string | null;
  propertyID: string | null;
  url: string | null;
  latitude: number | null;
  longitude: number | null;
  hoa: number | null;
}
/** What both adapters hand back for an injection point. `position` only matters when
 *  `insertAfter` is null: 'prepend' makes us the first child instead of the last. */
interface InjectionTarget {
  container: Element | null;
  insertAfter: Element | null;
  position?: 'append' | 'prepend';
}
interface SiteAdapter {
  id: string;
  matchesHost(h: string): boolean;
  isDetailPage(): boolean;
  detailInjectionTarget(): InjectionTarget | null;
  extractFromDetailPage(): HouseData | null;
  findCardElements(): Element[];
  isInjectableCard(el: Element): boolean;
  cardInjectionTarget(el: Element): InjectionTarget;
  extractFromCard(el: Element): HouseData | null;
  extraInjectionTargets(): unknown[];
  compFacts?(el: Element): { amountText: string | null; priceLabel: string | null; soldDateText: string } | null;
  isRentalDetailPage?(): boolean;
  listingStatusFromCard?(el: Element): string | null;
  mapPinContainer?(): Element | null;
  buildMapProjection?(): {
    container: Element;
    fit: unknown;
    clip?: DOMRect | null;
    anchor?: { dx: number; dy: number };
  } | null;
  mapClipElement?(): Element | null;
  mapPinAnchorOffset?(): { dx: number; dy: number };
  nativeMapPinForHouse?(house: Partial<HouseData>): Element | null;
  projectPoint?(projection: unknown, lat: number, lon: number): { x: number; y: number } | null;
}

let RedfinAdapter: SiteAdapter;
let ZillowAdapter: SiteAdapter;

/** jsdom can't navigate, so point document/location at the site under test. */
function setLocation(href: string) {
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...window.location, href, hostname: url.hostname, pathname: url.pathname,
      origin: url.origin, search: url.search
    }
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  ({ RedfinAdapter, ZillowAdapter } = loadAdapters());
});

describe('adapter selection', () => {
  it('picks Redfin for redfin.com and Zillow for zillow.com', () => {
    expect(RedfinAdapter.matchesHost('www.redfin.com')).toBe(true);
    expect(RedfinAdapter.matchesHost('www.zillow.com')).toBe(false);
    expect(ZillowAdapter.matchesHost('www.zillow.com')).toBe(true);
    expect(ZillowAdapter.matchesHost('www.redfin.com')).toBe(false);
  });

  // A naive substring check would match these; the anchored patterns must not.
  it('does not match lookalike hostnames', () => {
    expect(RedfinAdapter.matchesHost('redfin.com.evil.example')).toBe(false);
    expect(ZillowAdapter.matchesHost('notzillow.com')).toBe(false);
  });

  it('matches subdomains of each site', () => {
    expect(RedfinAdapter.matchesHost('www2.redfin.com')).toBe(true);
    expect(ZillowAdapter.matchesHost('m.zillow.com')).toBe(true);
  });
});

describe('RedfinAdapter - results page cards', () => {
  beforeEach(() => {
    setLocation('https://www.redfin.com/city/30794/TX/Dallas');
    document.body.innerHTML = `
      <div class="bp-Homecard">
        <div class="bp-Homecard__Content">
          <a href="/TX/Dallas/123-Main-St-75201/for-sale/30926649">link</a>
          <div class="bp-Homecard__Address">123 Main St, Dallas, TX 75201</div>
          <div class="bp-Homecard__Price"><span class="bp-Homecard__Price--value">$425,000</span></div>
          <div class="bp-Homecard__Stats">2 beds2 baths1,765 sq ft</div>
          <div class="bp-ShareExtension">share</div>
          <div class="bp-FavoriteExtension">fav</div>
        </div>
      </div>
      <div class="bp-Homecard DisplayAd">
        <div class="bp-Homecard__Content"><span>sponsored</span></div>
      </div>
    `;
  });

  it('is not treated as a detail page', () => {
    expect(RedfinAdapter.isDetailPage()).toBe(false);
  });

  it('finds the listing card and rejects the ad card', () => {
    const cards = RedfinAdapter.findCardElements();
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const injectable = cards.filter((c) => RedfinAdapter.isInjectableCard(c));
    expect(injectable).toHaveLength(1);
  });

  it('extracts every field from the card', () => {
    const card = RedfinAdapter.findCardElements().find((c) => RedfinAdapter.isInjectableCard(c))!;
    const h = RedfinAdapter.extractFromCard(card)!;

    expect(h.source).toBe('redfin');
    expect(h.address).toBe('123 Main St, Dallas, TX 75201');
    expect(h.price).toBe('$425,000');
    // Parsed from the single unpunctuated stats string, as measured live.
    expect(h.beds).toBe('2');
    expect(h.baths).toBe('2');
    expect(h.sqft).toBe('1765');
    // /for-sale/<id>, the scheme that broke the old /home/-only extraction.
    expect(h.propertyID).toBe('30926649');
    expect(h.url).toContain('/for-sale/30926649');
  });

  it('injects next to Favorite so it inherits the card action styling', () => {
    const card = RedfinAdapter.findCardElements().find((c) => RedfinAdapter.isInjectableCard(c))!;
    const { container, insertAfter } = RedfinAdapter.cardInjectionTarget(card);
    expect(container).not.toBeNull();
    expect((insertAfter as Element).className).toContain('bp-FavoriteExtension');
  });
});

describe('RedfinAdapter - compFacts (comp search cards)', () => {
  beforeEach(() => {
    // Sold card as measured live, zip 78745, TX (non-disclosure state): the big price
    // is the last-list price, and the sold sash carries the date.
    setLocation('https://www.redfin.com/zipcode/78745/filter/include=sold-6mo');
    document.body.innerHTML = `
      <div class="bp-Homecard">
        <div class="bp-Homecard__Content">
          <a href="/TX/Austin/456-Comp-Ave-78745/home/555">link</a>
          <div class="bp-Homecard__Address">456 Comp Ave, Austin, TX 78745</div>
          <div class="bp-Homecard__Price">
            <span class="bp-Homecard__Price--value">$369,500</span>
            <span class="bp-Homecard__Price--label">Last list price</span>
          </div>
          <div class="bp-Homecard__Stats">3 beds2 baths1,400 sq ft</div>
          <span class="sash">SOLD MAY 28, 2026</span>
        </div>
      </div>
    `;
  });

  it('reads the price, its label and the sold-sash text', () => {
    const card = RedfinAdapter.findCardElements()[0];
    const facts = RedfinAdapter.compFacts!(card)!;
    expect(facts.amountText).toBe('$369,500');
    expect(facts.priceLabel).toBe('Last list price');
    expect(facts.soldDateText).toContain('SOLD MAY 28, 2026');
  });

  it('returns null without a card element', () => {
    expect(RedfinAdapter.compFacts!(null as unknown as Element)).toBeNull();
  });
});

describe('RedfinAdapter - detail page', () => {
  beforeEach(() => {
    // A /for-sale/ URL: no "/home/" anywhere, which is what hid the Analyze button.
    setLocation('https://www.redfin.com/WA/Shoreline/322-NW-200th-St-98177/for-sale/77753');
    document.body.innerHTML = `
      <div class="MainHouseInfoPanel"></div>
      <div class="bp-homeAddress"><span class="full-address">322 NW 200th St, Shoreline, WA 98177</span></div>
      <div class="home-main-stats-variant">
        <div data-rf-test-id="abp-price"><span class="statsValue">$975,000</span></div>
        <div data-rf-test-id="abp-beds"><span class="statsValue">4</span></div>
        <div data-rf-test-id="abp-baths">3 ba</div>
        <div data-rf-test-id="abp-sqFt"><span class="statsValue">2,380</span></div>
      </div>
      <div class="bp-HomeControls"><div class="bp-pill-container-variant"></div></div>
      <div class="KeyDetailsTable">
        <div class="keyDetails-row">
          <span class="valueType">HOA Dues</span><span class="valueText">$145/month</span>
        </div>
      </div>
      <script type="application/ld+json">
        {"@type":"SingleFamilyResidence","url":"https://www.redfin.com/WA/Shoreline/322-NW-200th-St-98177/for-sale/77753","geo":{"latitude":47.77,"longitude":-122.35}}
      </script>
    `;
  });

  it('detects a detail page from the DOM even though the URL has no /home/', () => {
    expect(window.location.href).not.toContain('/home/');
    expect(RedfinAdapter.isDetailPage()).toBe(true);
    expect(RedfinAdapter.detailInjectionTarget()).not.toBeNull();
  });

  // The action row overflows rather than wraps once the side panel narrows the viewport,
  // so an appended button ended up past the right edge of the page, unreachable.
  it('prepends into the action row so the button survives a narrow viewport', () => {
    const target = RedfinAdapter.detailInjectionTarget()!;
    expect(target.container!.className).toContain('pill-container');
    expect(target.position).toBe('prepend');
    expect(target.insertAfter).toBeNull();
  });

  it('extracts the listing, including baths that have no .statsValue wrapper', () => {
    const h = RedfinAdapter.extractFromDetailPage()!;
    expect(h.source).toBe('redfin');
    expect(h.address).toBe('322 NW 200th St, Shoreline, WA 98177');
    expect(h.price).toBe('975000');
    expect(h.beds).toBe('4');
    // The bug that silently dropped every bathroom count and 400'd the rent API.
    expect(h.baths).toBe('3');
    expect(h.sqft).toBe('2380');
    expect(h.propertyID).toBe('77753');
    expect(h.hoa).toBe(145);
    expect(h.latitude).toBeCloseTo(47.77, 2);
  });

  it('reads coordinates from mainEntity.geo and coerces strings to numbers', () => {
    const script = document.querySelector('script[type="application/ld+json"]')!;
    script.textContent = JSON.stringify([{
      '@type': 'SingleFamilyResidence',
      url: 'https://www.redfin.com/WA/Shoreline/322-NW-200th-St-98177/for-sale/77753',
      mainEntity: { geo: { latitude: '47.771', longitude: '-122.351' } }
    }]);

    expect(RedfinAdapter.extractFromDetailPage()).toMatchObject({
      latitude: 47.771,
      longitude: -122.351
    });
  });

  it('uses the scoped geo.position meta fallback on a detail page', () => {
    document.querySelector('script[type="application/ld+json"]')!.remove();
    document.head.innerHTML = '<meta name="geo.position" content="47.772;-122.352">';

    expect(RedfinAdapter.extractFromDetailPage()).toMatchObject({
      latitude: 47.772,
      longitude: -122.352
    });
  });

  it('returns null rather than a partial record when the stats block is absent', () => {
    document.querySelector('.home-main-stats-variant')!.remove();
    expect(RedfinAdapter.extractFromDetailPage()).toBeNull();
  });
});

describe('RedfinAdapter - Coming Soon listing (no action bar)', () => {
  beforeEach(() => {
    // Verified live: a Coming Soon listing renders a ListingStatusBannerSection and
    // no Share/Save controls at all, so .bp-HomeControls matches nothing. Its data
    // still extracts fine, so it must remain capturable.
    setLocation('https://www.redfin.com/TX/Dallas/4303-Buena-Vista-St-75205/unit-306/home/31163990');
    document.body.innerHTML = `
      <div class="ListingStatusBannerSection remodel addressBannerRevamp">COMING SOON</div>
      <div class="MainHouseInfoPanel"></div>
      <header class="address">
        <div class="bp-homeAddress"><span class="full-address">4303 Buena Vista St #306, Dallas, TX 75205</span></div>
      </header>
      <div class="home-main-stats-variant">
        <div data-rf-test-id="abp-price"><span class="statsValue">$290,000</span></div>
        <div data-rf-test-id="abp-beds"><span class="statsValue">2</span></div>
        <div data-rf-test-id="abp-baths">1 ba</div>
        <div data-rf-test-id="abp-sqFt"><span class="statsValue">1,074</span></div>
      </div>
      <div class="KeyDetailsTable">
        <div class="keyDetails-row"><span class="valueType">HOA Dues</span><span class="valueText">$550/month</span></div>
      </div>
    `;
  });

  it('has no pill bar, confirming the fixture reproduces the real page', () => {
    expect(document.querySelector('.bp-HomeControls .bp-pill-container-variant')).toBeNull();
  });

  it('still resolves an injection target so the listing can be captured', () => {
    const target = RedfinAdapter.detailInjectionTarget()!;
    expect(target).not.toBeNull();
    // Falls through to the address header, as measured on the live page.
    expect(target.container!.tagName.toLowerCase()).toBe('header');
    // Appended, not prepended: prepending here would put the button ahead of the address.
    expect(target.position).toBe('append');
  });

  it('extracts the Coming Soon listing in full', () => {
    const h = RedfinAdapter.extractFromDetailPage()!;
    expect(h.propertyID).toBe('31163990');
    expect(h.price).toBe('290000');
    expect(h.beds).toBe('2');
    expect(h.baths).toBe('1');
    expect(h.sqft).toBe('1074');
    expect(h.hoa).toBe(550);
  });
});

describe('RedfinAdapter - rental listing detail page (third template)', () => {
  /**
   * Verified live 2026-07-29 on an active "For Rent" listing at a plain /home/<id>
   * URL -- indistinguishable by path from a for-sale listing. Neither
   * .MainHouseInfoPanel nor .home-main-stats-variant exist here, so isDetailPage()
   * used to return false and NO button -- comp or plain Analyze -- ever appeared.
   * Stats use data-rf-test-name, not data-rf-test-id; there's no .bp-homeAddress.
   */
  beforeEach(() => {
    setLocation('https://www.redfin.com/WA/Seattle/3851-38th-Ave-S-98118/home/171400');
    document.body.innerHTML = `
      <h1>3851 38th Ave S, Seattle, WA 98118</h1>
      <div class="bp-address-banner banner-content desktop">
        <div class="property-info">For rent$4,500/moPrice3bd&bull;3ba&bull;2,130sq ft3851 38th Ave S, Seattle, WA 98118</div>
      </div>
      <div class="stat-block price-section" data-rf-test-name="stat-price">
        <div class="statsValue price"><span>$4,500/mo</span></div><span class="statsLabel">Price</span>
      </div>
      <div class="stat-block beds-section" data-rf-test-name="stat-beds">
        <div class="statsValue">3</div><span class="statsLabel">bd</span>
      </div>
      <div class="stat-block baths-section" data-rf-test-name="stat-baths">
        <div class="statsValue">3</div><span class="statsLabel">ba</span>
      </div>
      <div class="stat-block sqft-section" data-rf-test-name="stat-sqft">
        <span class="statsValue">2,130</span><div class="statsLabel">sq ft</div>
      </div>
      <div class="pill-container-variant">
        <div class="FavoriteButtonCopFlyoutWrapper RentalControlButtonWrapper">
          <div class="bp-favoriteButtonWrapper" data-rf-test-id="abp-favoriteButton"></div>
        </div>
      </div>
      <script type="application/ld+json">
        {"@type":"Product","url":"https://www.redfin.com/WA/Seattle/3851-38th-Ave-S-98118/home/171400","geo":{"latitude":47.5682814,"longitude":-122.2853587}}
      </script>
    `;
  });

  it('is recognised as a detail page even with none of the for-sale template\'s markers', () => {
    expect(document.querySelector('.MainHouseInfoPanel')).toBeNull();
    expect(document.querySelector('.home-main-stats-variant')).toBeNull();
    expect(RedfinAdapter.isDetailPage()).toBe(true);
  });

  it('does not misfire on a rentals search results page', () => {
    document.body.innerHTML = '<div class="bp-Homecard__Content"></div>';
    expect(RedfinAdapter.isDetailPage()).toBe(false);
  });

  // content.js withholds the ordinary Analyze button on this template outside comp
  // mode: a rental's price is a monthly rent, not a purchase price to run through the
  // buy-and-hold calculator.
  it('identifies itself as a rental listing', () => {
    expect(RedfinAdapter.isRentalDetailPage!()).toBe(true);
  });

  it('does not misidentify a for-sale detail page as a rental', () => {
    document.body.innerHTML = '<div class="home-main-stats-variant"></div>';
    expect(RedfinAdapter.isRentalDetailPage!()).toBe(false);
  });

  it('resolves an injection target via the existing pill-container fallback', () => {
    const target = RedfinAdapter.detailInjectionTarget()!;
    expect(target).not.toBeNull();
    expect(target.container!.className).toBe('pill-container-variant');
  });

  it('extracts price, beds, baths and sqft from the data-rf-test-name stat blocks', () => {
    const h = RedfinAdapter.extractFromDetailPage()!;
    expect(h.source).toBe('redfin');
    expect(h.address).toBe('3851 38th Ave S, Seattle, WA 98118');
    expect(h.price).toBe('4500');
    expect(h.beds).toBe('3');
    expect(h.baths).toBe('3');
    expect(h.sqft).toBe('2130');
    expect(h.propertyID).toBe('171400');
    expect(h.hoa).toBeNull();
    expect(h.latitude).toBeCloseTo(47.5682814, 4);
  });

  it('returns null rather than a partial record when the rental stat blocks are absent', () => {
    document.querySelectorAll('.stat-block').forEach((el) => el.remove());
    // Falls through to the for-sale branch, which also finds nothing here.
    expect(RedfinAdapter.extractFromDetailPage()).toBeNull();
  });
});

describe('RedfinAdapter - map pin projection', () => {
  /** A pin as Redfin actually renders one: attributes for identity, inline left/top for position. */
  function pin(lat: number, lon: number, x: number, y: number) {
    const el = document.createElement('div');
    el.className = 'Pushpin';
    el.setAttribute('latitude', String(lat));
    el.setAttribute('longitude', String(lon));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    return el;
  }

  it('returns null with no map container on the page', () => {
    document.body.innerHTML = '<div class="bp-Homecard__Content"></div>';
    expect(RedfinAdapter.mapPinContainer!()).toBeNull();
    expect(RedfinAdapter.buildMapProjection!()).toBeNull();
  });

  it('returns null with fewer than two usable pins', () => {
    document.body.innerHTML = '<div class="HomeMarkersContainer"></div>';
    document.querySelector('.HomeMarkersContainer')!.appendChild(pin(30.27, -97.74, 400, 300));
    expect(RedfinAdapter.buildMapProjection!()).toBeNull();
  });

  it('fits a projection from two on-screen pins and reproduces a third pin\'s position', () => {
    document.body.innerHTML = '<div class="HomeMarkersContainer"></div>';
    const container = document.querySelector('.HomeMarkersContainer')!;
    // Real coordinates all fall on the same Austin page as docs/map-linking.md's recon.
    container.appendChild(pin(30.2672, -97.7431, 400, 300));
    container.appendChild(pin(30.3072, -97.7031, 600, 100));
    container.appendChild(pin(30.2872, -97.7231, 500, 200)); // held out; checked below

    const projection = RedfinAdapter.buildMapProjection!()!;
    expect(projection).not.toBeNull();
    // The third pin was not used as an anchor (min/max longitude picks the other two),
    // so reproducing its position close to (500, 200) is a real check, not a tautology.
    const result = RedfinAdapter.projectPoint!(projection, 30.2872, -97.7231)!;
    expect(result.x).toBeCloseTo(500, 0);
    expect(result.y).toBeCloseTo(200, 0);
  });

  it('ignores pins with missing or non-numeric geometry', () => {
    document.body.innerHTML = '<div class="HomeMarkersContainer"></div>';
    const container = document.querySelector('.HomeMarkersContainer')!;
    container.appendChild(pin(30.2672, -97.7431, 400, 300));
    const broken = document.createElement('div');
    broken.className = 'Pushpin';
    broken.setAttribute('latitude', 'not-a-number');
    broken.setAttribute('longitude', '-97.7');
    container.appendChild(broken);
    expect(RedfinAdapter.buildMapProjection!()).toBeNull();
  });

  it('projectPoint no-ops to null on a null projection', () => {
    expect(RedfinAdapter.projectPoint!(null, 30.27, -97.74)).toBeNull();
  });

  it('finds the native marker for a saved house by coordinates', () => {
    document.body.innerHTML = '<div class="HomeMarkersContainer"></div>';
    const container = document.querySelector('.HomeMarkersContainer')!;
    const target = pin(30.2672, -97.7431, 400, 300);
    container.appendChild(target);
    container.appendChild(pin(30.3072, -97.7031, 600, 100));

    expect(RedfinAdapter.nativeMapPinForHouse!({
      latitude: 30.2672,
      longitude: -97.7431
    })).toBe(target);
  });
});

describe('ZillowAdapter - detail page', () => {
  beforeEach(() => {
    setLocation('https://www.zillow.com/homedetails/1615-N-196th-Pl-Shoreline-WA-98133/48703301_zpid/');
    document.body.innerHTML = `
      <h1>1615 N 196th Pl, Shoreline, WA 98133</h1>
      <div data-testid="desktop-action-bar"><button>Save</button><button>Share</button></div>
      <span data-testid="price">$774,950</span>
      <div data-testid="bed-bath-sqft-facts">3beds2baths1,400sqft</div>
      <div data-testid="facts-and-features-module">Monthly HOA: $85</div>
      <script type="application/ld+json">
        {"@type":["RealEstateListing","Product"],"url":"https://www.zillow.com/homedetails/1615-N-196th-Pl-Shoreline-WA-98133/48703301_zpid/","offers":{"price":774950}}
      </script>
      <script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"x":{"latitude":47.7715,"longitude":-122.3421}}}}
      </script>
    `;
  });

  it('detects a Zillow detail page and finds the action bar', () => {
    expect(ZillowAdapter.isDetailPage()).toBe(true);
    const target = ZillowAdapter.detailInjectionTarget()!;
    expect(target).not.toBeNull();
    expect(target.container!.getAttribute('data-testid')).toBe('desktop-action-bar');
  });

  it('extracts the listing from the sources verified during recon', () => {
    const h = ZillowAdapter.extractFromDetailPage()!;
    expect(h.source).toBe('zillow');
    expect(h.propertyID).toBe('48703301');
    // Price comes from the ld+json RealEstateListing blob (numeric), not the rendered text.
    expect(h.price).toBe('774950');
    expect(h.beds).toBe('3');
    expect(h.baths).toBe('2');
    expect(h.sqft).toBe('1400');
    expect(h.address).toContain('1615 N 196th Pl');
    expect(h.hoa).toBe(85);
    // Geo is only accepted when tied to this zpid; this fixture's blob has none, so
    // it is correctly withheld. See the dedicated geo cases below.
    expect(h.latitude).toBeNull();
  });

  it('falls back to the rendered price when the ld+json blob is missing', () => {
    document.querySelector('script[type="application/ld+json"]')!.remove();
    expect(ZillowAdapter.extractFromDetailPage()!.price).toBe('$774,950');
  });

  it('still captures without geo rather than failing outright', () => {
    document.getElementById('__NEXT_DATA__')!.remove();
    const h = ZillowAdapter.extractFromDetailPage()!;
    expect(h.propertyID).toBe('48703301');
    expect(h.latitude).toBeNull();
  });

  it('ignores an implausible geo pair instead of trusting it', () => {
    document.getElementById('__NEXT_DATA__')!.textContent = '{"latitude":0,"longitude":0}';
    expect(ZillowAdapter.extractFromDetailPage()!.latitude).toBeNull();
  });

  it('rejects out-of-range coordinates', () => {
    document.getElementById('__NEXT_DATA__')!.textContent = '{"latitude":999,"longitude":-122.3}';
    expect(ZillowAdapter.extractFromDetailPage()!.latitude).toBeNull();
  });

  /**
   * The payload can describe several homes. Reading the first "latitude" and the
   * first "longitude" independently -- as an earlier version did -- can splice
   * together coordinates from two different houses, which would silently produce a
   * rent estimate for the wrong neighbourhood. Both must come from one object.
   */
  it('prefers the coordinate pair belonging to this zpid over a neighbour listed first', () => {
    document.getElementById('__NEXT_DATA__')!.textContent = JSON.stringify({
      props: {
        nearby: [{ zpid: 99999999, latitude: 40.0, longitude: -100.0 }],
        current: { zpid: 48703301, latitude: 47.7715, longitude: -122.3421 }
      }
    });
    const h = ZillowAdapter.extractFromDetailPage()!;
    expect(h.latitude).toBeCloseTo(47.7715, 3);
    expect(h.longitude).toBeCloseTo(-122.3421, 3);
  });

  it('never splices latitude and longitude from different objects', () => {
    document.getElementById('__NEXT_DATA__')!.textContent = JSON.stringify({
      zpid: 48703301,
      a: { latitude: 40.0 },                          // lat only, no pair
      b: { longitude: -100.0 },                       // lng only, no pair
      c: { latitude: 47.7715, longitude: -122.3421 }  // the only real pair
    });
    const h = ZillowAdapter.extractFromDetailPage()!;
    expect(h.latitude).toBeCloseTo(47.7715, 3);
    expect(h.longitude).toBeCloseTo(-122.3421, 3);
  });

  /**
   * Deliberate: coordinates not tied to this zpid are discarded rather than used.
   * They may belong to a neighbouring listing in the same payload, and a rent
   * estimate for the wrong neighbourhood looks authoritative while being wrong.
   * Missing geo is visible; wrong geo is not. Geocoding the address is the correct
   * way to fill this in.
   */
  it('returns no geo rather than an unattributed coordinate pair', () => {
    document.getElementById('__NEXT_DATA__')!.textContent = JSON.stringify({
      props: { pageProps: { x: { latitude: 47.7715, longitude: -122.3421 } } }
    });
    const h = ZillowAdapter.extractFromDetailPage()!;
    expect(h.latitude).toBeNull();
    expect(h.longitude).toBeNull();
    // The capture itself must still succeed -- only the rent estimate is affected.
    expect(h.propertyID).toBe('48703301');
    expect(h.price).toBe('774950');
  });

  it('ignores a neighbour\'s coordinates even when no pair exists for this zpid', () => {
    document.getElementById('__NEXT_DATA__')!.textContent = JSON.stringify({
      nearby: [{ zpid: 99999999, latitude: 40.0, longitude: -100.0 }],
      current: { zpid: 48703301, address: 'no coords here' }
    });
    expect(ZillowAdapter.extractFromDetailPage()!.latitude).toBeNull();
  });

  it('survives a malformed __NEXT_DATA__ blob without throwing', () => {
    document.getElementById('__NEXT_DATA__')!.textContent = '{not json';
    expect(() => ZillowAdapter.extractFromDetailPage()).not.toThrow();
    expect(ZillowAdapter.extractFromDetailPage()!.latitude).toBeNull();
  });

  /**
   * parseStateCode in background.js needs ", XX 12345" to call the tax/rent services.
   * A detail-page h1 is often street-only, so the document title is preferred when it
   * carries state and ZIP.
   */
  it('prefers an address carrying state and ZIP so the rent API can use it', () => {
    document.querySelector('h1')!.textContent = '1615 N 196th Pl';
    document.title = '1615 N 196th Pl, Shoreline, WA 98133 | MLS #123 | Zillow';
    const h = ZillowAdapter.extractFromDetailPage()!;
    expect(h.address).toMatch(/WA\s+98133/);
  });

  it('falls back to the h1 when the title has no state and ZIP', () => {
    document.querySelector('h1')!.textContent = '1615 N 196th Pl, Shoreline, WA 98133';
    document.title = 'Some Zillow Page | Zillow';
    expect(ZillowAdapter.extractFromDetailPage()!.address).toContain('1615 N 196th Pl');
  });

  it('is not fooled into detail mode on a results page', () => {
    setLocation('https://www.zillow.com/shoreline-wa/');
    expect(ZillowAdapter.isDetailPage()).toBe(false);
  });
});

describe('ZillowAdapter - rental listing detail page', () => {
  /**
   * Verified live 2026-07-29: a Zillow rental's own detail page still publishes a
   * RealEstateListing ld+json blob with a numeric offers.price (no "/mo" anywhere in
   * it), the same as a for-sale listing's. isRentalDetailPage has to read the
   * *rendered* price text instead, or every rental detail page looks exactly like a
   * for-sale one to it.
   */
  beforeEach(() => {
    setLocation('https://www.zillow.com/homedetails/918-W-Fullerton-Ave-APT-2-Chicago-IL-60614/3730740_zpid/');
    document.body.innerHTML = `
      <h1>918 W Fullerton Ave, APT 2, Chicago, IL 60614</h1>
      <span data-testid="price">$3,500/mo</span>
      <script type="application/ld+json">
        {"@type":["RealEstateListing","Product"],"url":"https://www.zillow.com/homedetails/918-W-Fullerton-Ave-APT-2-Chicago-IL-60614/3730740_zpid/","offers":{"price":3500}}
      </script>
    `;
  });

  it('identifies itself as a rental from the rendered price text', () => {
    expect(ZillowAdapter.isRentalDetailPage!()).toBe(true);
  });

  // The trap: extractFromDetailPage's own price is the clean ld+json number, which
  // carries no "/mo" -- isRentalDetailPage must not be built on top of it.
  it('is a rental even though extractFromDetailPage\'s own price has no "/mo"', () => {
    expect(ZillowAdapter.extractFromDetailPage()!.price).toBe('3500');
    expect(ZillowAdapter.isRentalDetailPage!()).toBe(true);
  });

  it('does not misidentify a for-sale detail page as a rental', () => {
    document.querySelector('[data-testid="price"]')!.textContent = '$774,950';
    expect(ZillowAdapter.isRentalDetailPage!()).toBe(false);
  });
});

describe('ZillowAdapter - showcase detail template', () => {
  /**
   * Verified live on a Chicago high-rise condo. This template has none of the standard
   * page's markers -- no desktop-action-bar, no bed-bath-sqft-facts, no
   * [data-testid="price"] -- so requiring them classified it as a results page: the
   * house got no Analyze button while nine appeared on the similar-homes cards below.
   */
  beforeEach(() => {
    setLocation('https://www.zillow.com/homedetails/1000-N-Lake-Shore-Plz-APT-24C-Chicago-IL-60611/2090044928_zpid/');
    document.title = '1000 N Lake Shore Plz APT 24C, Chicago, IL 60611 | MLS #12710163 | Zillow';
    document.body.innerHTML = `
      <h1>1000 N Lake Shore Plz APT 24C, Chicago, IL 60611</h1>
      <!-- Transcribed from the live showcase page: the action controls are <li> items in a
           <ul data-testid="action-bar-links-container">, laid out row-reverse, and the
           bar's first child is a bare Back button. Save carries only an aria-label. -->
      <div data-testid="showcase-action-bar-container">
        <div data-testid="action-bar">
          <nav>
            <button>Back</button>
            <ul data-testid="action-bar-links-container">
              <li><button aria-label="Save">Save</button></li>
              <li><button data-testid="share-button">Share</button></li>
              <li><button data-testid="more-menu">More</button></li>
            </ul>
          </nav>
        </div>
      </div>
      <div data-testid="desktop-bed-bath-sqft">2beds3baths2,100sqft</div>
      <div data-testid="facts-and-features">Association fee: $1,850 monthly</div>
      <script type="application/ld+json">
        {"@type":["RealEstateListing","Product"],"url":"https://www.zillow.com/homedetails/1000-N-Lake-Shore-Plz-APT-24C-Chicago-IL-60611/2090044928_zpid/","offers":{"price":750000}}
      </script>
      <article id="zpid_9999"><a href="/homedetails/other/9999_zpid/">neighbour</a></article>
    `;
  });

  it('is recognised as a detail page despite having none of the standard markers', () => {
    expect(document.querySelector('[data-testid="desktop-action-bar"]')).toBeNull();
    expect(document.querySelector('[data-testid="bed-bath-sqft-facts"]')).toBeNull();
    expect(ZillowAdapter.isDetailPage()).toBe(true);
  });

  /**
   * The container must be the <ul>, not Save's <li>. Injecting into the <li> put the button
   * *inside* the Save item, where it stacked underneath rather than sitting alongside --
   * verified live before this was fixed.
   */
  it('injects into the action-link list as a peer of Save, not inside its item', () => {
    const target = ZillowAdapter.detailInjectionTarget()!;
    expect(target.container!.getAttribute('data-testid')).toBe('action-bar-links-container');

    const item = target.insertAfter!;
    expect(item).not.toBeNull();
    expect(item.tagName.toLowerCase()).toBe('li');
    expect(item.textContent).toMatch(/save/i);
    // insertAfter must be a direct child of container or injectInto falls back to append.
    expect(item.parentElement).toBe(target.container);
  });

  it('finds the save control by testid when this template uses one', () => {
    document.querySelector('[data-testid="action-bar-links-container"]')!.innerHTML =
      '<li id="s"><button data-testid="save-button">♥</button></li><li><button>Share</button></li>';
    const target = ZillowAdapter.detailInjectionTarget()!;
    expect((target.insertAfter as HTMLElement).id).toBe('s');
  });

  // "Save this search" is a different control; matching it would anchor us to the wrong thing.
  it('does not mistake a save-search control for the listing save button', () => {
    document.querySelector('[data-testid="action-bar-links-container"]')!.innerHTML =
      '<li><button>Save this search</button></li>';
    const target = ZillowAdapter.detailInjectionTarget()!;
    expect(target.container!.getAttribute('data-testid')).toBe('action-bar-links-container');
    expect(target.insertAfter).toBeNull();
  });

  it('still resolves a target when the link list has no save control at all', () => {
    document.querySelector('[data-testid="action-bar-links-container"]')!.innerHTML =
      '<li><button data-testid="more-menu">More</button></li>';
    const target = ZillowAdapter.detailInjectionTarget()!;
    expect(target.container!.getAttribute('data-testid')).toBe('action-bar-links-container');
    expect(target.insertAfter).toBeNull();
  });

  it('falls back to the showcase bar itself when there is no action-link list', () => {
    document.querySelector('[data-testid="action-bar-links-container"]')!.remove();
    const target = ZillowAdapter.detailInjectionTarget()!;
    expect(target.container!.getAttribute('data-testid')).toBe('showcase-action-bar-container');
  });

  it('extracts the listing from this template\'s selectors', () => {
    const h = ZillowAdapter.extractFromDetailPage()!;
    expect(h.propertyID).toBe('2090044928');
    expect(h.price).toBe('750000');
    expect(h.beds).toBe('2');
    expect(h.baths).toBe('3');
    expect(h.sqft).toBe('2100');
    expect(h.address).toMatch(/IL\s+60611/);
  });

  // A results page's own URL never contains "<digits>_zpid", so linking to
  // /homedetails/ can't make it look like a detail page.
  it('does not mistake a results page for a detail page', () => {
    setLocation('https://www.zillow.com/chicago-il/');
    expect(ZillowAdapter.isDetailPage()).toBe(false);
  });
});

describe('ZillowAdapter - results page cards', () => {
  beforeEach(() => {
    setLocation('https://www.zillow.com/shoreline-wa/');
    /**
     * The facts are separate <li> elements immediately after the price, which is the detail
     * that mattered: element.textContent renders this whole card as
     * "$774,9503 bds2 ba1,400 sqft", gluing the price's trailing digits to the bed count.
     * Live, every card on the page reported beds as "0002"/"9993" and so on. The previous
     * fixture put the facts in one tidy <div>, so the suite never saw it.
     */
    // Written without whitespace between the price and the facts list: React renders no
    // whitespace text nodes there, and an indented fixture would not reproduce the glue.
    document.body.innerHTML =
      '<article id="zpid_48703301">'
      + '<a href="/homedetails/1615-N-196th-Pl-Shoreline-WA-98133/48703301_zpid/">x</a>'
      + '<span data-testid="property-card-price">$774,950</span>'
      + '<ul><li>3 bds</li><li>2 ba</li><li>1,400 sqft</li></ul>'
      + '<address data-testid="property-card-address-link">1615 N 196th Pl, Shoreline, WA 98133</address>'
      + '<button data-testid="property-card-save">save</button>'
      + '</article>'
      + '<article id="zpid_ad"><span>advertisement, no listing link</span></article>';
  });

  it('reproduces the glued textContent the live page produces', () => {
    const card = ZillowAdapter.findCardElements()[0];
    expect(card.textContent).toContain('$774,9503 bds');
  });

  // [data-test="property-card"] matched nothing on the live page; article[id^=zpid_] did.
  it('finds cards as article[id^="zpid_"]', () => {
    expect(ZillowAdapter.findCardElements()).toHaveLength(2);
  });

  it('rejects a card with no listing link', () => {
    const cards = ZillowAdapter.findCardElements();
    expect(cards.filter((c) => ZillowAdapter.isInjectableCard(c))).toHaveLength(1);
  });

  it('extracts the card, deriving the zpid from its link', () => {
    const card = ZillowAdapter.findCardElements()[0];
    const h = ZillowAdapter.extractFromCard(card)!;
    expect(h.source).toBe('zillow');
    expect(h.propertyID).toBe('48703301');
    expect(h.price).toBe('$774,950');
    // 3, not "0003": read from separated text rather than the glued textContent.
    expect(h.beds).toBe('3');
    expect(h.baths).toBe('2');
    expect(h.sqft).toBe('1400');
  });

  it('accepts an exact-price apartment card and uses its numeric article id', () => {
    document.body.innerHTML =
      '<article id="zpid_2069881355">'
      + '<a href="https://www.zillow.com/apartments/chicago-il/example/5XjKXK/">x</a>'
      + '<span data-testid="property-card-price">$2,295/mo</span>'
      + '<address data-testid="property-card-address-link">2332 W Addison St, Chicago, IL 60618</address>'
      + '</article>';
    const card = ZillowAdapter.findCardElements()[0];

    expect(ZillowAdapter.isInjectableCard(card)).toBe(true);
    const h = ZillowAdapter.extractFromCard(card)!;
    expect(h.propertyID).toBe('2069881355');
    expect(h.price).toBe('$2,295/mo');
    expect(h.url).toContain('/apartments/');
  });

  it.each([
    ['$750,000', '2 bds', '3 ba', '2,100 sqft', '2', '3', '2100'],
    ['$569,999', '3 bds', '2 ba', '1,650 sqft', '3', '2', '1650'],
    ['$1,000,000', '4 bds', '3 ba', '3,000 sqft', '4', '3', '3000']
  ])('reads the real bed count for a %s listing', (price, bd, ba, sq, beds, baths, sqft) => {
    const card = ZillowAdapter.findCardElements()[0];
    card.querySelector('[data-testid="property-card-price"]')!.textContent = price;
    card.querySelector('ul')!.innerHTML = `<li>${bd}</li><li>${ba}</li><li>${sq}</li>`;

    const h = ZillowAdapter.extractFromCard(card)!;
    expect(h.beds).toBe(beds);
    expect(h.baths).toBe(baths);
    expect(h.sqft).toBe(sqft);
  });

  it('falls back to the article id when the link is unreadable', () => {
    const card = ZillowAdapter.findCardElements()[0];
    card.querySelector('a')!.removeAttribute('href');
    expect(ZillowAdapter.extractFromCard(card)!.propertyID).toBe('48703301');
  });

  it('has no coordinates without a __NEXT_DATA__ payload', () => {
    const card = ZillowAdapter.findCardElements()[0];
    const h = ZillowAdapter.extractFromCard(card)!;
    expect(h.latitude).toBeNull();
    expect(h.longitude).toBeNull();
  });
});

/**
 * A results-page card carries no coordinates in its own DOM (verified live,
 * docs/map-linking.md §2) -- they have to be looked up in the search payload embedded
 * in __NEXT_DATA__, matched by zpid. This used to be hardcoded null unconditionally,
 * which blocked both rent estimation and the map-pin feature for every Zillow card
 * capture.
 */
describe('ZillowAdapter - card geo from listResults', () => {
  function nextDataScript(listResults: unknown[]) {
    const script = document.createElement('script');
    script.id = '__NEXT_DATA__';
    script.type = 'application/json';
    script.textContent = JSON.stringify({
      props: { pageProps: { searchPageState: { cat1: { searchResults: { listResults } } } } }
    });
    return script;
  }

  beforeEach(() => {
    setLocation('https://www.zillow.com/shoreline-wa/');
    document.body.innerHTML =
      '<article id="zpid_48703301">'
      + '<a href="/homedetails/1615-N-196th-Pl-Shoreline-WA-98133/48703301_zpid/">x</a>'
      + '<span data-testid="property-card-price">$774,950</span>'
      + '</article>';
  });

  it('reads latLong for the matching zpid', () => {
    document.body.appendChild(nextDataScript([
      { zpid: 99999999, latLong: { latitude: 40.0, longitude: -100.0 } },
      { zpid: 48703301, latLong: { latitude: 47.7715, longitude: -122.3421 } }
    ]));
    const card = ZillowAdapter.findCardElements()[0];
    const h = ZillowAdapter.extractFromCard(card)!;
    expect(h.latitude).toBeCloseTo(47.7715, 3);
    expect(h.longitude).toBeCloseTo(-122.3421, 3);
  });

  it('accepts the lat/lng spelling as well as latitude/longitude', () => {
    document.body.appendChild(nextDataScript([
      { zpid: 48703301, latLong: { lat: 47.7715, lng: -122.3421 } }
    ]));
    const card = ZillowAdapter.findCardElements()[0];
    const h = ZillowAdapter.extractFromCard(card)!;
    expect(h.latitude).toBeCloseTo(47.7715, 3);
  });

  it('returns null when no record matches this zpid', () => {
    document.body.appendChild(nextDataScript([
      { zpid: 11111111, latLong: { latitude: 40.0, longitude: -100.0 } }
    ]));
    const card = ZillowAdapter.findCardElements()[0];
    const h = ZillowAdapter.extractFromCard(card)!;
    expect(h.latitude).toBeNull();
    expect(h.longitude).toBeNull();
  });

  it('returns null on a malformed __NEXT_DATA__ blob without throwing', () => {
    const script = document.createElement('script');
    script.id = '__NEXT_DATA__';
    script.type = 'application/json';
    script.textContent = '{not json';
    document.body.appendChild(script);
    const card = ZillowAdapter.findCardElements()[0];
    expect(() => ZillowAdapter.extractFromCard(card)).not.toThrow();
    expect(ZillowAdapter.extractFromCard(card)!.latitude).toBeNull();
  });

  it('rejects an out-of-range coordinate pair', () => {
    document.body.appendChild(nextDataScript([
      { zpid: 48703301, latLong: { latitude: 999, longitude: -122.3421 } }
    ]));
    const card = ZillowAdapter.findCardElements()[0];
    expect(ZillowAdapter.extractFromCard(card)!.latitude).toBeNull();
  });
});

describe('ZillowAdapter - map pin projection', () => {
  function mockRect(el: HTMLElement, rect: { left: number; top: number; width: number; height: number }) {
    el.getBoundingClientRect = () => ({
      ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height,
      x: rect.left, y: rect.top, toJSON() { return this; }
    });
  }

  const bounds = { west: -97.8, east: -97.6, south: 30.2, north: 30.4 };
  const urlWithBounds = (value: unknown) => {
    const state = encodeURIComponent(JSON.stringify({ isMapVisible: true, mapBounds: value }));
    return `https://www.zillow.com/austin-tx/?searchQueryState=${state}`;
  };

  beforeEach(() => {
    setLocation(urlWithBounds(bounds));
    document.body.innerHTML = '';

    const decoy = document.createElement('div');
    decoy.className = 'zillow-map-layer';
    mockRect(decoy, { left: 0, top: 0, width: 0, height: 0 });
    document.body.appendChild(decoy);

    const layer = document.createElement('div');
    layer.className = 'zillow-map-layer';
    mockRect(layer, { left: 0, top: 0, width: 0, height: 0 });
    const marker = document.createElement('div');
    marker.className = 'streamlined-marker-container';
    layer.appendChild(marker);
    document.body.appendChild(layer);

    const clip = document.createElement('div');
    clip.id = 'search-page-map';
    mockRect(clip, { left: 0, top: 0, width: 1000, height: 800 });
    document.body.appendChild(clip);
  });

  it('selects the marker-bearing layer rather than the first layer', () => {
    expect(ZillowAdapter.mapPinContainer!()!.querySelector('.streamlined-marker-container')).not.toBeNull();
  });

  it('returns null with no map layer on the page', () => {
    document.querySelectorAll('.zillow-map-layer').forEach((el) => el.remove());
    expect(ZillowAdapter.buildMapProjection!()).toBeNull();
  });

  it('returns null with no clip element or URL bounds', () => {
    document.getElementById('search-page-map')!.remove();
    expect(ZillowAdapter.buildMapProjection!()).toBeNull();
    setLocation('https://www.zillow.com/austin-tx/');
    expect(ZillowAdapter.buildMapProjection!()).toBeNull();
  });

  it('rejects degenerate and out-of-range bounds', () => {
    setLocation(urlWithBounds({ west: 0, east: 0, south: 0, north: 0 }));
    expect(ZillowAdapter.buildMapProjection!()).toBeNull();
    setLocation(urlWithBounds({ west: -97.8, east: -97.6, south: 30.2, north: 999 }));
    expect(ZillowAdapter.buildMapProjection!()).toBeNull();
  });

  it('fits the map pane to URL bounds without dispatching page events', () => {
    const seen: string[] = [];
    for (const type of ['mouseover', 'mouseout', 'mousemove', 'pointerover', 'click']) {
      document.addEventListener(type, () => seen.push(type), { capture: true, once: true });
    }

    const projection = ZillowAdapter.buildMapProjection!()!;
    expect(seen).toEqual([]);
    const nw = ZillowAdapter.projectPoint!(projection, bounds.north, bounds.west)!;
    const se = ZillowAdapter.projectPoint!(projection, bounds.south, bounds.east)!;
    expect(nw.x).toBeCloseTo(0, 6);
    expect(nw.y).toBeCloseTo(0, 6);
    expect(se.x).toBeCloseTo(1000, 6);
    expect(se.y).toBeCloseTo(800, 6);
    expect(projection.clip!.width).toBe(1000);
    expect(projection.anchor).toEqual({ dx: 0, dy: 0 });
  });

  it('calibrates a cold projection with exactly two delayed card-hover probes', async () => {
    vi.useFakeTimers();
    try {
      setLocation('https://www.zillow.com/austin-tx/');
      const layer = ZillowAdapter.mapPinContainer!() as HTMLElement;
      layer.innerHTML = '';
      const points = [
        { id: '1001', latitude: 30.25, longitude: -97.75, x: 200, y: 600 },
        { id: '1002', latitude: 30.35, longitude: -97.65, x: 800, y: 200 }
      ];
      const payload = document.createElement('script');
      payload.id = '__NEXT_DATA__';
      payload.type = 'application/json';
      payload.textContent = JSON.stringify({
        props: {
          pageProps: {
            searchPageState: {
              cat1: {
                searchResults: {
                  listResults: points.map((point) => ({
                    zpid: point.id,
                    latLong: { latitude: point.latitude, longitude: point.longitude }
                  }))
                }
              }
            }
          }
        }
      });
      document.body.appendChild(payload);

      let hoverCount = 0;
      for (const point of points) {
        const marker = document.createElement('div');
        marker.className = 'streamlined-marker-container';
        const pill = document.createElement('span');
        mockRect(pill, { left: point.x - 10, top: point.y - 10, width: 20, height: 20 });
        marker.appendChild(pill);
        layer.appendChild(marker);

        const card = document.createElement('article');
        card.id = `zpid_${point.id}`;
        card.innerHTML = `<a href="/homedetails/test/${point.id}_zpid/"></a>`;
        card.addEventListener('mouseover', () => {
          hoverCount += 1;
          setTimeout(() => pill.classList.add('is-hovered'), 50);
        });
        card.addEventListener('mouseout', () => pill.classList.remove('is-hovered'));
        document.body.appendChild(card);
      }

      expect(ZillowAdapter.buildMapProjection!()).toBeNull();
      await vi.advanceTimersByTimeAsync(400);
      const projection = ZillowAdapter.buildMapProjection!();

      expect(projection).not.toBeNull();
      expect(hoverCount).toBe(2);
      expect(document.querySelector('.is-hovered')).toBeNull();
      const first = ZillowAdapter.projectPoint!(
        projection!, points[0].latitude, points[0].longitude
      )!;
      expect(first.x).toBeCloseTo(points[0].x, 4);
      expect(first.y).toBeCloseTo(points[0].y, 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('projectPoint no-ops to null on a null projection', () => {
    expect(ZillowAdapter.projectPoint!(null, 30.27, -97.74)).toBeNull();
  });
});

describe('ZillowAdapter - compFacts (comp search cards)', () => {
  beforeEach(() => {
    setLocation('https://www.zillow.com/homes/recently_sold/78745_rb/3-3_beds/2-_baths/');
    document.body.innerHTML =
      '<article id="zpid_48703301">'
      + '<a href="/homedetails/1615-N-196th-Pl-Shoreline-WA-98133/48703301_zpid/">x</a>'
      + '<span data-testid="property-card-price">$--</span>'
      + '</article>';
  });

  // Zillow renders no separate price-label text -- the non-disclosure "$--" is the
  // whole signal -- so priceLabel is always null and the amount itself is what the
  // caller (parseCompAmount) has to recognise as unusable.
  it('reads the amount text with no price label', () => {
    const card = ZillowAdapter.findCardElements()[0];
    const facts = ZillowAdapter.compFacts!(card)!;
    expect(facts.amountText).toBe('$--');
    expect(facts.priceLabel).toBeNull();
  });

  it('returns null without a card element', () => {
    expect(ZillowAdapter.compFacts!(null as unknown as Element)).toBeNull();
  });
});

describe('cross-site id isolation', () => {
  // Both sites use bare digits, so storage must namespace by source or a zpid could
  // overwrite a Redfin listing that happens to share the number.
  it('tags every record with its source so ids cannot collide', () => {
    setLocation('https://www.redfin.com/WA/x/for-sale/48703301');
    document.body.innerHTML = `
      <div class="MainHouseInfoPanel"></div>
      <div class="bp-homeAddress"><span class="full-address">A</span></div>
      <div class="home-main-stats-variant">
        <div data-rf-test-id="abp-price"><span class="statsValue">$1</span></div>
      </div>`;
    const redfin = RedfinAdapter.extractFromDetailPage()!;

    expect(redfin.propertyID).toBe('48703301');
    expect(redfin.source).toBe('redfin');
    // Same numeric id, different source -> must be distinguishable downstream.
    expect(`${redfin.source}:${redfin.propertyID}`).not.toBe(`zillow:48703301`);
  });
});

/**
 * Both sites are SPAs, and server-rendered ld+json head scripts can outlive a client-side
 * navigation -- content.js's own comments record 8 stale card buttons observed live on
 * Zillow. An unscoped "first RealEstateListing blob" read, preferred over the rendered
 * price, could therefore pair the previous listing's price with the current listing's
 * address. Coordinates have the same failure mode and drive the rent estimate.
 */
describe('ld+json is scoped to the listing being captured', () => {
  it('Zillow ignores a stale blob describing a different zpid', () => {
    setLocation('https://www.zillow.com/homedetails/current/2222_zpid/');
    document.title = '9 New St, Chicago, IL 60611 | Zillow';
    document.body.innerHTML =
      '<h1>9 New St, Chicago, IL 60611</h1>'
      + '<div data-testid="price">$500,000</div>'
      + '<div data-testid="bed-bath-sqft-facts">2beds1baths900sqft</div>'
      + '<script type="application/ld+json">'
      + '{"@type":["RealEstateListing","Product"],'
      + '"url":"https://www.zillow.com/homedetails/previous/1111_zpid/",'
      + '"offers":{"price":9999999}}'
      + '</script>';

    const h = ZillowAdapter.extractFromDetailPage()!;
    expect(h.propertyID).toBe('2222');
    // The rendered price, not the stale blob's.
    expect(h.price).toBe('$500,000');
    expect(h.price).not.toContain('9999999');
  });

  it('Zillow still prefers the structured price when the blob is this listing', () => {
    setLocation('https://www.zillow.com/homedetails/current/2222_zpid/');
    document.title = '9 New St, Chicago, IL 60611 | Zillow';
    document.body.innerHTML =
      '<h1>9 New St, Chicago, IL 60611</h1>'
      + '<div data-testid="price">$500,000</div>'
      + '<div data-testid="bed-bath-sqft-facts">2beds1baths900sqft</div>'
      + '<script type="application/ld+json">'
      + '{"@type":["RealEstateListing","Product"],'
      + '"url":"https://www.zillow.com/homedetails/current/2222_zpid/",'
      + '"offers":{"price":512000}}'
      + '</script>';

    expect(ZillowAdapter.extractFromDetailPage()!.price).toBe('512000');
  });

  it('Zillow picks its own blob out of several', () => {
    setLocation('https://www.zillow.com/homedetails/current/2222_zpid/');
    document.title = '9 New St, Chicago, IL 60611 | Zillow';
    document.body.innerHTML =
      '<h1>9 New St, Chicago, IL 60611</h1>'
      + '<div data-testid="price">$500,000</div>'
      + '<div data-testid="bed-bath-sqft-facts">2beds1baths900sqft</div>'
      + '<script type="application/ld+json">{"@type":"RealEstateListing","url":"https://www.zillow.com/homedetails/old/1111_zpid/","offers":{"price":111}}</script>'
      + '<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>'
      + '<script type="application/ld+json">{"@type":"RealEstateListing","url":"https://www.zillow.com/homedetails/current/2222_zpid/","offers":{"price":222000}}</script>';

    expect(ZillowAdapter.extractFromDetailPage()!.price).toBe('222000');
  });

  it('Redfin withholds coordinates from a stale blob rather than using another house\'s', () => {
    setLocation('https://www.redfin.com/WA/Shoreline/9-New-St-98177/home/55555');
    document.body.innerHTML = `
      <div class="MainHouseInfoPanel"></div>
      <div class="bp-homeAddress"><span class="full-address">9 New St, Shoreline, WA 98177</span></div>
      <div class="home-main-stats-variant">
        <div data-rf-test-id="abp-price"><span class="statsValue">$500,000</span></div>
        <div data-rf-test-id="abp-beds"><span class="statsValue">2</span></div>
        <div data-rf-test-id="abp-baths">1 ba</div>
        <div data-rf-test-id="abp-sqFt"><span class="statsValue">900</span></div>
      </div>
      <script type="application/ld+json">
        {"@type":"SingleFamilyResidence","url":"https://www.redfin.com/WA/Other/1-Old-Rd-98001/home/11111","geo":{"latitude":47.11,"longitude":-122.11}}
      </script>
    `;

    const h = RedfinAdapter.extractFromDetailPage()!;
    expect(h.propertyID).toBe('55555');
    // Withheld, per the standing rule that unverifiable coordinates are not used.
    expect(h.latitude).toBeNull();
    expect(h.longitude).toBeNull();
  });

  it('Redfin accepts coordinates from its own blob', () => {
    setLocation('https://www.redfin.com/WA/Shoreline/9-New-St-98177/home/55555');
    document.body.innerHTML = `
      <div class="MainHouseInfoPanel"></div>
      <div class="bp-homeAddress"><span class="full-address">9 New St, Shoreline, WA 98177</span></div>
      <div class="home-main-stats-variant">
        <div data-rf-test-id="abp-price"><span class="statsValue">$500,000</span></div>
        <div data-rf-test-id="abp-beds"><span class="statsValue">2</span></div>
        <div data-rf-test-id="abp-baths">1 ba</div>
        <div data-rf-test-id="abp-sqFt"><span class="statsValue">900</span></div>
      </div>
      <script type="application/ld+json">
        {"@type":"SingleFamilyResidence","url":"https://www.redfin.com/WA/Shoreline/9-New-St-98177/home/55555","geo":{"latitude":47.77,"longitude":-122.35}}
      </script>
    `;

    const h = RedfinAdapter.extractFromDetailPage()!;
    expect(h.latitude).toBeCloseTo(47.77, 2);
  });
});
