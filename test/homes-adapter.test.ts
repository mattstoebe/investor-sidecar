import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads the real adapter files (public/scripts/sites/*.js) into this jsdom environment,
 * the same way site-adapters.test.ts does -- the adapters are plain content scripts, so
 * they're evaluated rather than imported, but it is the shipped code under test.
 *
 * Every DOM string here is transcribed from a live measurement recorded in
 * docs/homes-com-feasibility.md, across 4 markets and 4 property types. That matters more
 * than usual on this site: a detail page embeds up to nine similar/sold cards using the
 * *identical* markup as a results card, so a fixture invented to match the adapter would
 * happily pass while the adapter read a comp's numbers. Two of the tests below exist
 * precisely because that happened during recon.
 */
function loadAdapters() {
  const read = (p: string) => readFileSync(resolve(__dirname, '../public/scripts/sites/', p), 'utf8');
  const bundle = [read('parsers.js'), read('geo-projection.js'), read('homes.js')].join(';\n');
  const factory = new Function(`${bundle}; return { SidecarParsers, HomesAdapter };`);
  return factory() as { HomesAdapter: HomesSiteAdapter };
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
  details?: Record<string, unknown> & {
    tax?: { history?: unknown[]; [key: string]: unknown };
  };
}
interface InjectionTarget {
  container: Element | null;
  insertAfter: Element | null;
  position?: 'append' | 'prepend';
}
interface HomesSiteAdapter {
  id: string;
  matchesHost(h: string): boolean;
  isValidPropertyId(id: unknown): boolean;
  isDetailPage(): boolean;
  isRentalDetailPage(): boolean;
  listingStatusFromCard(el: Element): string | null;
  detailInjectionTarget(): InjectionTarget | null;
  extractFromDetailPage(): HouseData | null;
  findCardElements(): Element[];
  isInjectableCard(el: Element): boolean;
  cardInjectionTarget(el: Element): InjectionTarget;
  extractFromCard(el: Element): HouseData | null;
  compFacts(el: Element): { amountText: string | null; priceLabel: string | null; soldDateText: string } | null;
  mapPinContainer(): Element | null;
  mapClipElement(): Element | null;
  buildMapProjection(): {
    container: Element;
    host?: Element | null;
    fit: unknown;
    clip: DOMRect | null;
    anchor: { dx: number; dy: number };
  } | null;
  projectPoint(projection: unknown, lat: number, lon: number): { x: number; y: number } | null;
  extraInjectionTargets(): Array<{
    container: Element;
    insertAfter: Element | null;
    className: string;
    extract(): HouseData | null;
    listingStatus(): string;
    compFacts(): { amountText: string | null; priceLabel: string | null; soldDateText: string } | null;
    isCompEligible(kind: 'rent' | 'sold'): boolean;
  }>;
}

let HomesAdapter: HomesSiteAdapter;

/** jsdom can't navigate, so point document/location at the page under test. */
function setLocation(href: string) {
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, href, hostname: url.hostname, pathname: url.pathname, origin: url.origin }
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  ({ HomesAdapter } = loadAdapters());
});

/**
 * A results-page card. Measured shape: article.search-placard carrying data-pk, an
 * <address> with the full address, .price-container, and a .detailed-info-container whose
 * beds/baths/sqft are separate <li> elements.
 *
 * The <script type="text/template"> is not decoration. Homes.com inlines carousel
 * templates inside every card, and a TreeWalker over the whole article returns that raw
 * markup as text -- so a whole-card separatedText() (which is what the Zillow adapter
 * does) parses HTML here. Its numbers are chosen to be wrong on purpose.
 */
function cardHtml(opts: {
  pk: string;
  price: string;
  address: string;
  facts: string[];
  detailUrl?: string;
  /** Sold-search cards glue a label into the price container: "$341,990 Last List Price". */
  priceLabel?: string;
  /** The sold sash, its own element: "Sold Mar 11, 2026". */
  soldPill?: string;
}) {
  const href = opts.detailUrl ?? `/property/${opts.address.split(',')[0].toLowerCase().replace(/\s+/g, '-')}/${opts.pk}/`;
  return `
    <article class="search-placard for-sale-placard silver-level" data-pk="${opts.pk}" data-listing-title="${opts.address}">
      <script type="text/template" id="embla-slide-template">
        <div class="embla__slide"><a href="${href}"><img data-pos="9" data-est="8 Beds 9 Baths 9,999 Sq Ft"></a></div>
      </script>
      <div class="for-sale-content-container">
        <p class="price-container">${opts.price}${opts.priceLabel ? `<span class="last-list-price-label">${opts.priceLabel}</span>` : ''}</p>
        ${opts.soldPill ? `<span class="status-pill tag-type-sold">${opts.soldPill}</span>` : ''}
        <ul class="detailed-info-container">${opts.facts.map((f) => `<li>${f}</li>`).join('')}</ul>
        <address>${opts.address}</address>
        <div class="placard-user-actions-container">
          <button class="favorite-button" aria-label="Add to Favorites"></button>
          <button class="plain-button placard-action btn-kebab" aria-label="More Actions"></button>
        </div>
        <a href="${href}" role="link"></a>
      </div>
    </article>`;
}

/**
 * A detail page: the subject's own block, plus one similar/sold card using the identical
 * results-card markup. The comp's numbers deliberately differ from the subject's, because
 * that difference is the whole point of these fixtures.
 *
 * Subject facts are label/value sibling pairs, not a single string:
 * .property-info-feature > .property-info-feature-detail ("2.5") + .feature-baths ("Baths").
 */
function detailHtml(opts: {
  price: string;
  street: string;
  beds: string;
  bedsLabel?: string;
  baths: string;
  sqft: string;
  amenities?: string;
  comp?: { pk: string; price: string; address: string; facts: string[] };
  ldJson?: string;
  rentLabel?: string;
}) {
  const feature = (value: string, labelClass: string, label: string) =>
    `<div class="property-info-feature"><span class="property-info-feature-detail">${value}</span><span class="${labelClass}">${label}</span></div>`;

  const comp = opts.comp ? cardHtml(opts.comp) : '';
  const ld = opts.ldJson ? `<script type="application/ld+json">${opts.ldJson}</script>` : '';

  return `
    ${ld}
    <main id="mainContent" class="main-content">
      <section class="listing-profile-container">
        <div class="ldp-grid-container"><div class="profile-column-left">
          <div class="ldp-property-info-container ldp-section-container">
            <div class="property-info-price-and-icons">
              <div class="${opts.rentLabel ? 'property-info-rent-container' : ''}">
                <span class="property-info-price" id="price">${opts.price}</span>
                ${opts.rentLabel ? `<span class="property-info-price price-label">${opts.rentLabel}</span>` : ''}
              </div>
              <span class="status-pill">$15K PRICE DROP</span>
              <div class="property-info-user-actions">
                <button class="plain-button btn-like favorite-button" aria-label="Add to Favorites"></button>
                <button class="share-item share-dd flyout" aria-label="Share"></button>
              </div>
            </div>
            <div class="property-info-address"><h1>${opts.street}\n\n   </h1></div>
            <div class="property-info-features plain-list flex">
              ${feature(opts.beds, 'feature-beds', opts.bedsLabel ?? 'Beds')}
              ${feature(opts.baths, 'feature-baths', 'Baths')}
              ${feature(opts.sqft, 'feature-sqft', 'Sq Ft')}
              ${feature('$270', 'feature-pricepersqt', 'Price per Sq Ft')}
            </div>
          </div>
          <section id="amenities-container" class="ldp-section-container amenities-container">
            ${opts.amenities ?? ''}
          </section>
        </div></div>
        ${comp}
      </section>
    </main>`;
}

/** The real ld+json shape: one @graph with a RealEstateListing+Product node. */
function ldJson(opts: {
  pk: string;
  slug: string;
  name: string;
  price?: number | null;
  beds?: number;
  baths?: number;
  sqft?: number;
  geo?: { latitude: number; longitude: number } | null;
}) {
  const url = `https://www.homes.com/property/${opts.slug}/${opts.pk}/`;
  const listing: Record<string, unknown> = {
    '@type': ['RealEstateListing', 'Product'],
    url,
    '@id': `${url}#realestatelisting`,
    name: opts.name,
    mainEntity: {
      '@type': 'SingleFamilyResidence',
      numberOfBedrooms: opts.beds ?? 4,
      numberOfBathroomsTotal: opts.baths ?? 2,
      floorSize: { '@type': 'QuantitativeValue', value: opts.sqft ?? 2282, unitCode: 'FTK' },
      address: { '@type': 'PostalAddress', streetAddress: opts.name.split(',')[0] },
      ...(opts.geo === null ? {} : { geo: { '@type': 'GeoCoordinates', ...(opts.geo ?? { latitude: 30.21396, longitude: -97.80625 }) } })
    }
  };
  if (opts.price !== null) listing.offers = { '@type': 'Offer', price: opts.price ?? 615000, priceCurrency: 'USD', url };
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': [listing, { '@type': 'BreadcrumbList' }] });
}

const AMUR_LD = ldJson({
  pk: 'vff9j5680b68l',
  slug: '2200-amur-dr-austin-tx-unit-b35',
  name: '2200 Amur Dr Unit B35, Austin, TX 78745'
});

describe('HomesAdapter — host and page classification', () => {
  it('matches homes.com and its subdomains, and nothing adjacent', () => {
    expect(HomesAdapter.matchesHost('www.homes.com')).toBe(true);
    expect(HomesAdapter.matchesHost('homes.com')).toBe(true);
    expect(HomesAdapter.matchesHost('www.zillow.com')).toBe(false);
    // Would be matched by a naive /homes\.com/ test.
    expect(HomesAdapter.matchesHost('homes.com.evil.example')).toBe(false);
    expect(HomesAdapter.matchesHost('nothomes.com')).toBe(false);
  });

  it('treats only a /property/<slug>/<pk>/ path as a detail page', () => {
    // Real paths, from the recon.
    for (const path of ['/austin-tx/', '/austin-tx/homes-for-sale/', '/austin-tx/apartments-for-rent/', '/agents/', '/news/']) {
      setLocation(`https://www.homes.com${path}`);
      expect(HomesAdapter.isDetailPage(), path).toBe(false);
    }
    setLocation('https://www.homes.com/property/2200-amur-dr-austin-tx-unit-b35/vff9j5680b68l/');
    expect(HomesAdapter.isDetailPage()).toBe(true);
    // Trailing slash is optional on the real site.
    setLocation('https://www.homes.com/property/2200-amur-dr-austin-tx-unit-b35/vff9j5680b68l');
    expect(HomesAdapter.isDetailPage()).toBe(true);
  });

  it('classifies a detail page by URL even though it contains card markup', () => {
    // Nine similar-homes cards were present on a real detail page. A DOM-based check
    // would call this a results page, leaving the subject with no button.
    setLocation('https://www.homes.com/property/2200-amur-dr-austin-tx-unit-b35/vff9j5680b68l/');
    document.body.innerHTML = detailHtml({
      price: '$615,000', street: '2200 Amur Dr Unit B35', beds: '4', baths: '2.5', sqft: '2,282',
      comp: { pk: 'aaaaaaaaaaaaa', price: '$399,900', address: '1 Comp St, Austin, TX 78745', facts: ['2 Beds', '2 Baths', '1,000 Sq Ft'] }
    });
    expect(HomesAdapter.isDetailPage()).toBe(true);
    expect(HomesAdapter.findCardElements()).toHaveLength(1);
  });

  it('accepts alphanumeric ids but still rejects the empties the guard exists for', () => {
    expect(HomesAdapter.isValidPropertyId('vff9j5680b68l')).toBe(true);
    expect(HomesAdapter.isValidPropertyId('1dqw0v173n35j')).toBe(true);
    expect(HomesAdapter.isValidPropertyId(null)).toBe(false);
    expect(HomesAdapter.isValidPropertyId('')).toBe(false);
    expect(HomesAdapter.isValidPropertyId('N/A')).toBe(false);
    // The id rule itself would yield "abc" for a hand-typed /property/foo/abc/.
    expect(HomesAdapter.isValidPropertyId('abc')).toBe(false);
  });
});

describe('HomesAdapter — results-page cards', () => {
  beforeEach(() => {
    setLocation('https://www.homes.com/austin-tx/');
  });

  it('extracts a card, taking facts from the stats list and not the card', () => {
    document.body.innerHTML = cardHtml({
      pk: 'vff9j5680b68l',
      price: '$615,000',
      address: '2200 Amur Dr Unit B35, Austin, TX 78745',
      facts: ['4 Beds', '2.5 Baths', '2,282 Sq Ft'],
      detailUrl: '/property/2200-amur-dr-austin-tx-unit-b35/vff9j5680b68l/'
    });
    const house = HomesAdapter.extractFromCard(HomesAdapter.findCardElements()[0])!;

    expect(house).toMatchObject({
      source: 'homes',
      address: '2200 Amur Dr Unit B35, Austin, TX 78745',
      price: '$615,000',
      beds: '4',
      baths: '2.5',
      sqft: '2282',
      propertyID: 'vff9j5680b68l',
      url: 'https://www.homes.com/property/2200-amur-dr-austin-tx-unit-b35/vff9j5680b68l/',
      latitude: null,
      longitude: null,
      hoa: null
    });
    // Regression: the inlined <script type="text/template"> carries "8 Beds 9 Baths
    // 9,999 Sq Ft". A whole-card separatedText() would return that raw markup as text
    // and these would be 8/9/9999.
    expect(house.beds).not.toBe('8');
    expect(house.sqft).not.toBe('9999');
  });

  it('joins a card to its map marker coordinates by property key', () => {
    document.body.innerHTML = `${cardHtml({
      pk: 'vff9j5680b68l',
      price: '$615,000',
      address: '2200 Amur Dr Unit B35, Austin, TX 78745',
      facts: ['4 Beds', '2.5 Baths', '2,282 Sq Ft']
    })}
      <gmp-advanced-marker data-pin-pk="vff9j5680b68l" position="30.26522,-97.74668"></gmp-advanced-marker>`;

    expect(HomesAdapter.extractFromCard(HomesAdapter.findCardElements()[0])).toMatchObject({
      latitude: 30.26522,
      longitude: -97.74668
    });
  });

  it('reads a studio as 0 beds rather than giving up', () => {
    // Measured on Chicago condos: "Studio 1 Bath 420 Sq Ft" -- no bed count at all, so
    // the shared parser alone returns null.
    document.body.innerHTML = cardHtml({
      pk: 'qzz736tq2pelq',
      price: '$134,500',
      address: '601 E 32nd St Unit 403, Chicago, IL 60616',
      facts: ['Studio', '1 Bath', '420 Sq Ft']
    });
    const house = HomesAdapter.extractFromCard(HomesAdapter.findCardElements()[0])!;
    expect(house.beds).toBe('0');
    expect(house.baths).toBe('1');
    expect(house.sqft).toBe('420');
  });

  it('leaves genuinely absent sqft null rather than inventing one', () => {
    // 7 of 40 Chicago condo cards rendered "1 Bed 1 Bath" with no sqft.
    document.body.innerHTML = cardHtml({
      pk: 'g8jc35492xnnz',
      price: '$118,500',
      address: '953 E 61st St Unit 1E, Chicago, IL 60637',
      facts: ['1 Bed', '1 Bath']
    });
    const house = HomesAdapter.extractFromCard(HomesAdapter.findCardElements()[0])!;
    expect(house).toMatchObject({ beds: '1', baths: '1', sqft: null });
  });

  it('falls back to the listing href when data-detail-url is absent', () => {
    // Present on Austin cards, absent on Chicago ones -- so it cannot be depended on.
    document.body.innerHTML = cardHtml({
      pk: 'g8jc35492xnnz',
      price: '$118,500',
      address: '953 E 61st St Unit 1E, Chicago, IL 60637',
      facts: ['1 Bed', '1 Bath'],
      detailUrl: '/property/953-e-61st-st-chicago-il-unit-1e/g8jc35492xnnz/'
    });
    const card = HomesAdapter.findCardElements()[0];
    card.removeAttribute('data-detail-url');
    const house = HomesAdapter.extractFromCard(card)!;
    expect(house.url).toBe('https://www.homes.com/property/953-e-61st-st-chicago-il-unit-1e/g8jc35492xnnz/');
    expect(house.propertyID).toBe('g8jc35492xnnz');
  });

  it('anchors the button beside the card’s own favourite control', () => {
    document.body.innerHTML = cardHtml({
      pk: 'vff9j5680b68l', price: '$615,000', address: '2200 Amur Dr, Austin, TX 78745', facts: ['4 Beds', '2.5 Baths', '2,282 Sq Ft']
    });
    const card = HomesAdapter.findCardElements()[0];
    const target = HomesAdapter.cardInjectionTarget(card);
    expect(target.container).toBe(card.querySelector('.placard-user-actions-container'));
    expect(target.insertAfter).toBe(card.querySelector('.favorite-button'));
  });

  it('rejects a card with no id, and accepts a real one', () => {
    document.body.innerHTML = cardHtml({
      pk: 'vff9j5680b68l', price: '$615,000', address: '2200 Amur Dr, Austin, TX 78745', facts: ['4 Beds']
    });
    const card = HomesAdapter.findCardElements()[0];
    expect(HomesAdapter.isInjectableCard(card)).toBe(true);
    card.removeAttribute('data-pk');
    expect(HomesAdapter.isInjectableCard(card)).toBe(false);
  });

  it('reads a rental card’s current price, address, and rendered monthly unit', () => {
    document.body.innerHTML = `
      <article class="search-placard for-rent-mls-placard" data-pk="fl6r0zg27zyf6">
        <div class="for-rent-mls-content-container">
          <p class="current-price"><span>$2,300</span><span class="rent-indicator">Per Month</span></p>
          <ul class="detailed-info-container"><li>3 Beds</li><li>2 Baths</li><li>1,200 Sq Ft</li><li>Apartment for Rent</li></ul>
          <p class="address">5852 S Prairie Ave Unit 2, Chicago, IL 60637</p>
          <div class="placard-user-actions-container"><button class="favorite-button"></button></div>
          <a href="/property/5852-s-prairie-ave-chicago-il-unit-2/fl6r0zg27zyf6/"></a>
        </div>
      </article>`;
    const card = HomesAdapter.findCardElements()[0];
    expect(HomesAdapter.isInjectableCard(card)).toBe(true);
    expect(HomesAdapter.listingStatusFromCard!(card)).toBe('rental');
    expect(HomesAdapter.extractFromCard(card)).toMatchObject({
      address: '5852 S Prairie Ave Unit 2, Chicago, IL 60637', price: '$2,300 Per Month',
      beds: '3', baths: '2', sqft: '1200'
    });
    expect(HomesAdapter.compFacts(card)!.amountText).toBe('$2,300 Per Month');
  });

  it('does not mistake “SOLD As-Is” marketing copy for a sold listing', () => {
    document.body.innerHTML = cardHtml({
      pk: 'kzkds44knlm8c', price: '$299,900', address: '4158 S Campbell Ave, Chicago, IL 60632',
      facts: ['2 Beds', '3 Baths']
    }).replace(
      '</address>',
      '</address><p class="property-description">Property needs some work, SOLD As-Is.</p>'
    );
    const card = HomesAdapter.findCardElements()[0];
    expect(HomesAdapter.listingStatusFromCard(card)).toBe('active');
  });
});

describe('HomesAdapter — detail page', () => {
  beforeEach(() => {
    setLocation('https://www.homes.com/property/2200-amur-dr-austin-tx-unit-b35/vff9j5680b68l/');
    document.title = '2200 Amur Dr Unit B35, Austin, TX 78745 | Homes.com';
  });

  it('extracts the subject house', () => {
    document.body.innerHTML = detailHtml({
      price: '$615,000', street: '2200 Amur Dr Unit B35', beds: '4', baths: '2.5', sqft: '2,282',
      amenities: '<h3 class="amenity-name">HOA Fees</h3><li class="amenities-detail">$125 Monthly HOA Fees</li>',
      ldJson: AMUR_LD
    });
    expect(HomesAdapter.extractFromDetailPage()).toMatchObject({
      source: 'homes',
      address: '2200 Amur Dr Unit B35, Austin, TX 78745',
      price: '615000',
      beds: '4',
      baths: '2.5',
      sqft: '2282',
      propertyID: 'vff9j5680b68l',
      url: 'https://www.homes.com/property/2200-amur-dr-austin-tx-unit-b35/vff9j5680b68l/',
      latitude: 30.21396,
      longitude: -97.80625,
      hoa: 125
    });
  });

  it('reads the subject’s price, not a comp’s', () => {
    // Regression. On the real Amur Dr page .price-container returned $399,900 -- a
    // similar-homes card -- against the subject's $615,000. On a Chicago condo it
    // returned "$180,000 Sold Feb 27, 2026", a sold comparable.
    document.body.innerHTML = detailHtml({
      price: '$615,000', street: '2200 Amur Dr Unit B35', beds: '4', baths: '2.5', sqft: '2,282',
      ldJson: AMUR_LD,
      comp: { pk: 'aaaaaaaaaaaaa', price: '$180,000 Sold Feb 27, 2026', address: '1 Comp St, Austin, TX 78745', facts: ['2 Beds', '2 Baths', '1,000 Sq Ft'] }
    });
    const house = HomesAdapter.extractFromDetailPage()!;
    expect(house.price).toBe('615000');
    expect(house.price).not.toContain('180,000');
  });

  it('reads the subject’s facts, not a comp’s', () => {
    // Regression, and the one that nearly shipped: on the real studio page
    // .detailed-info-container returned "2 Beds 2 Baths 1,000 Sq Ft" for a 420 sqft
    // studio, because that selector belongs to the comp carousel.
    setLocation('https://www.homes.com/property/601-e-32nd-st-chicago-il-unit-403/qzz736tq2pelq/');
    document.title = '601 E 32nd St Unit 403, Chicago, IL 60616 | Homes.com';
    document.body.innerHTML = detailHtml({
      price: '$134,500', street: '601 E 32nd St Unit 403',
      beds: '', bedsLabel: 'Studio', baths: '1', sqft: '420',
      amenities: '<li class="amenities-detail">$562 Monthly HOA Fees</li>',
      ldJson: ldJson({
        pk: 'qzz736tq2pelq', slug: '601-e-32nd-st-chicago-il-unit-403',
        name: '601 E 32nd St Unit 403, Chicago, IL 60616',
        price: 134500, beds: 0, baths: 1, sqft: 420,
        geo: { latitude: 41.83572, longitude: -87.61217 }
      }),
      comp: { pk: 'bbbbbbbbbbbbb', price: '$435,000', address: '2 Comp Ave, Chicago, IL 60616', facts: ['2 Beds', '2 Baths', '1,000 Sq Ft'] }
    });
    const house = HomesAdapter.extractFromDetailPage()!;
    expect(house.sqft).toBe('420');
    expect(house.beds).toBe('0');
    expect(house.baths).toBe('1');
    expect(house.hoa).toBe(562);
  });

  it('prefers the rendered half-bath over ld+json’s whole number', () => {
    // Measured: numberOfBathroomsTotal was 2 where the listing renders "2.5 Baths".
    // A dropped half-bath silently moves DSCR.
    document.body.innerHTML = detailHtml({
      price: '$615,000', street: '2200 Amur Dr Unit B35', beds: '4', baths: '2.5', sqft: '2,282',
      ldJson: AMUR_LD
    });
    expect(HomesAdapter.extractFromDetailPage()!.baths).toBe('2.5');
  });

  it('falls back to #price when ld+json carries no offer', () => {
    // The Cleveland multi-family had no `offers` node at all.
    setLocation('https://www.homes.com/property/11101-nelson-ave-cleveland-oh/7jh1ej9sqlecz/');
    document.title = '11101 Nelson Ave, Cleveland, OH 44105 | Homes.com';
    document.body.innerHTML = detailHtml({
      price: '$139,900', street: '11101 Nelson Ave', beds: '6', baths: '2', sqft: '1,848',
      ldJson: ldJson({
        pk: '7jh1ej9sqlecz', slug: '11101-nelson-ave-cleveland-oh',
        name: '11101 Nelson Ave', price: null, beds: 6, baths: 2, sqft: 1848
      })
    });
    const house = HomesAdapter.extractFromDetailPage()!;
    expect(house.price).toBe('$139,900');
    // And ld+json's street-only name loses to the title, which has the state and ZIP the
    // tax and rent services need.
    expect(house.address).toBe('11101 Nelson Ave, Cleveland, OH 44105');
  });

  it('ignores an ld+json blob belonging to another listing', () => {
    // SPA navigations leave the previous listing's server-rendered blob in the document.
    document.body.innerHTML = detailHtml({
      price: '$615,000', street: '2200 Amur Dr Unit B35', beds: '4', baths: '2.5', sqft: '2,282',
      ldJson: ldJson({
        pk: 'zzzzzzzzzzzzz', slug: 'somewhere-else-tx',
        name: '99 Other Rd, Elsewhere, TX 79999', price: 999000,
        geo: { latitude: 31.0, longitude: -98.0 }
      })
    });
    const house = HomesAdapter.extractFromDetailPage()!;
    expect(house.price).toBe('$615,000');
    expect(house.address).toBe('2200 Amur Dr Unit B35, Austin, TX 78745');
    // Coordinates from the wrong listing would drive a rent estimate for the wrong
    // neighbourhood, which looks entirely authoritative. Better to have none.
    expect(house.latitude).toBeNull();
    expect(house.longitude).toBeNull();
  });

  it('does not mistake “Shoal Creek” for an HOA fee', () => {
    // "Shoal" contains a case-insensitive "hoa", and Shoal Creek is a real Austin street.
    document.body.innerHTML = detailHtml({
      price: '$175,000', street: '7801 Shoal Creek Blvd Unit 252', beds: '2', baths: '1', sqft: '914',
      amenities: '<li class="amenities-detail">Located in the highly desirable North Shoal Creek area</li>',
      ldJson: AMUR_LD
    });
    expect(HomesAdapter.extractFromDetailPage()!.hoa).toBeNull();
  });

  it('anchors the button in the subject’s action row', () => {
    document.body.innerHTML = detailHtml({
      price: '$615,000', street: '2200 Amur Dr Unit B35', beds: '4', baths: '2.5', sqft: '2,282', ldJson: AMUR_LD
    });
    const target = HomesAdapter.detailInjectionTarget()!;
    expect(target.container).toBe(document.querySelector('.property-info-user-actions'));
    expect(target.insertAfter).toBe(document.querySelector('.property-info-user-actions .favorite-button'));
  });

  it('recognizes the rendered per-month unit on rental details', () => {
    document.body.innerHTML = detailHtml({
      price: '$2,999', street: '211 N Harbor Dr Unit 2007', beds: '1', baths: '1', sqft: '--',
      rentLabel: 'Per Month', ldJson: AMUR_LD
    });
    expect(HomesAdapter.isRentalDetailPage()).toBe(true);
  });

  it('does not mistake a normal detail price block for a rental', () => {
    document.body.innerHTML = detailHtml({
      price: '$615,000', street: '2200 Amur Dr Unit B35', beds: '4', baths: '2.5', sqft: '2,282', ldJson: AMUR_LD
    });
    expect(HomesAdapter.isRentalDetailPage()).toBe(false);
  });

  it('returns null rather than a partial house when the page has no price', () => {
    document.body.innerHTML = '<main id="mainContent"></main>';
    expect(HomesAdapter.extractFromDetailPage()).toBeNull();
  });

  it('has no extra injection targets', () => {
    expect(HomesAdapter.extraInjectionTargets()).toEqual([]);
  });
});

describe('HomesAdapter — sold cards and comp mode', () => {
  beforeEach(() => {
    setLocation('https://www.homes.com/austin-tx/sold/');
  });

  /** Measured on /austin-tx/sold/: the label shares a parent with the price, and the
   *  sold date has its own pill. Both differ from the for-sale card shape. */
  const soldCard = () => cardHtml({
    pk: 'txqsg2379c7eg',
    price: '$341,990',
    priceLabel: 'Last List Price',
    soldPill: 'Sold Mar 11, 2026',
    address: '8111 Springsteen Dr, Austin, TX 78744',
    // A sold card carries a fourth stat the for-sale card doesn't.
    facts: ['2 Beds', '2 Baths', '1,437 Sq Ft', 'Built 2026']
  });

  it('keeps the price parseable on a sold card', () => {
    // Regression: .price-container reads "$341,990 Last List Price" as one string, and
    // parseMoney requires the cleaned text to be entirely numeric -- so the whole
    // container turned every sold capture into a house with no usable price.
    document.body.innerHTML = soldCard();
    const house = HomesAdapter.extractFromCard(HomesAdapter.findCardElements()[0])!;
    expect(house.price).toBe('$341,990');
    expect(house.price).not.toMatch(/Last List/i);
  });

  it('still reads beds, baths and sqft past the extra "Built" stat', () => {
    document.body.innerHTML = soldCard();
    const house = HomesAdapter.extractFromCard(HomesAdapter.findCardElements()[0])!;
    expect(house).toMatchObject({ beds: '2', baths: '2', sqft: '1437' });
  });

  it('reports comp facts, including the site\u2019s own price label', () => {
    document.body.innerHTML = soldCard();
    expect(HomesAdapter.compFacts(HomesAdapter.findCardElements()[0])).toEqual({
      amountText: '$341,990',
      priceLabel: 'Last List Price',
      soldDateText: 'Sold Mar 11, 2026'
    });
  });

  it('leaves priceLabel null on a card that carries none', () => {
    document.body.innerHTML = cardHtml({
      pk: 'vff9j5680b68l', price: '$615,000',
      address: '2200 Amur Dr Unit B35, Austin, TX 78745',
      facts: ['4 Beds', '2.5 Baths', '2,282 Sq Ft']
    });
    const facts = HomesAdapter.compFacts(HomesAdapter.findCardElements()[0])!;
    expect(facts.amountText).toBe('$615,000');
    expect(facts.priceLabel).toBeNull();
    // No sold pill: falls back to the stats text, never the whole card (which would
    // include the inlined carousel template markup).
    expect(facts.soldDateText).not.toMatch(/<div|embla/);
  });

  it('returns null for no card', () => {
    expect(HomesAdapter.compFacts(null as unknown as Element)).toBeNull();
  });
});

describe('HomesAdapter — map popup card', () => {
  it('extracts and classifies the Google Maps info-window card separately from search cards', () => {
    document.body.innerHTML = `
      <div class="gm-style-iw"><div id="click-card-container" class="click-card-container">
        <a href="/property/726-n-troy-st-chicago-il/kbvbfwd3qnh65/" data-pk="kbvbfwd3qnh65">
          <div class="top-line-container"><button class="favorite-button"></button><p class="property-price">$380,000</p></div>
          <ul class="property-info-container"><li>3 Beds</li><li>1 Bath</li></ul>
          <p class="property-address">726 N Troy St</p><p class="property-city-state-zip">Chicago, IL 60612</p>
        </a>
      </div></div>`;
    const extra = HomesAdapter.extraInjectionTargets()[0];
    expect(extra.container.className).toBe('top-line-container');
    expect(extra.className).toContain('sidecar-MapPopupCalculator');
    expect(extra.extract()).toMatchObject({
      propertyID: 'kbvbfwd3qnh65', address: '726 N Troy St, Chicago, IL 60612', price: '$380,000',
      beds: '3', baths: '1', sqft: null
    });
    expect(extra.listingStatus()).toBe('active');
    expect(extra.isCompEligible('sold')).toBe(true);
    expect(extra.isCompEligible('rent')).toBe(false);
  });

  it('recognizes a monthly map popup as a rent-comp-only target', () => {
    document.body.innerHTML = `
      <div class="gm-style-iw"><div class="click-card-container">
        <a href="/property/5852-s-prairie-ave-chicago-il-unit-2/fl6r0zg27zyf6/" data-pk="fl6r0zg27zyf6">
          <div class="top-line-container"><button class="favorite-button"></button><p class="property-price">$2,300 Per Month</p></div>
          <ul class="property-info-container"><li>3 Beds</li><li>2 Baths</li></ul>
          <p class="property-address">5852 S Prairie Ave Unit 2</p><p class="property-city-state-zip">Chicago, IL 60637</p>
        </a>
      </div></div>`;
    const extra = HomesAdapter.extraInjectionTargets()[0];
    expect(extra.listingStatus()).toBe('rental');
    expect(extra.isCompEligible('rent')).toBe(true);
    expect(extra.isCompEligible('sold')).toBe(false);
  });

  it('joins a map popup to its marker coordinates by property key', () => {
    document.body.innerHTML = `
      <div>
        <gmp-advanced-marker data-pin-pk="kbvbfwd3qnh65" position="41.8951,-87.7024"></gmp-advanced-marker>
      </div>
      <div class="gm-style-iw"><div class="click-card-container">
        <a href="/property/726-n-troy-st-chicago-il/kbvbfwd3qnh65/" data-pk="kbvbfwd3qnh65">
          <div class="top-line-container"><button class="favorite-button"></button><p class="property-price">$380,000</p></div>
          <ul class="property-info-container"><li>3 Beds</li><li>1 Bath</li></ul>
          <p class="property-address">726 N Troy St</p><p class="property-city-state-zip">Chicago, IL 60612</p>
        </a>
      </div></div>`;

    expect(HomesAdapter.extraInjectionTargets()[0].extract()).toMatchObject({
      latitude: 41.8951,
      longitude: -87.7024
    });
  });
});

describe('HomesAdapter — map projection', () => {
  const mockRect = (element: Element, left: number, top: number, width: number, height: number) => {
    element.getBoundingClientRect = () => ({
      left, top, width, height, right: left + width, bottom: top + height,
      x: left, y: top, toJSON() { return this; }
    });
  };

  it('fits Advanced Markers and clips against the real map pane', () => {
    document.body.innerHTML = `
      <div id="map" class="search-map-container"></div>
      <div id="marker-origin">
        <gmp-advanced-marker position="30.2,-97.8" style="transform: matrix(1, 0, 0, 1, 100, 700)"></gmp-advanced-marker>
        <gmp-advanced-marker position="30.4,-97.6" style="transform: matrix(1, 0, 0, 1, 900, 100)"></gmp-advanced-marker>
      </div>`;
    mockRect(document.getElementById('map')!, 500, 100, 1000, 800);
    mockRect(document.getElementById('marker-origin')!, 500, 100, 574, 0);

    const projection = HomesAdapter.buildMapProjection()!;
    expect(projection).not.toBeNull();
    expect(projection.clip).toMatchObject({ left: 500, top: 100, width: 1000, height: 800 });
    expect(projection.host).toBe(document.getElementById('map'));
    expect(projection.anchor).toEqual({ dx: 14.5, dy: 40 });
    const projected = HomesAdapter.projectPoint(projection, 30.2, -97.8)!;
    expect(projected.x).toBeCloseTo(100, 4);
    expect(projected.y).toBeCloseTo(700, 4);
  });
});

describe('HomesAdapter — detail enrichment', () => {
  it('extracts annual tax, tax year, and canonical property facts', () => {
    setLocation('https://www.homes.com/property/953-e-61st-st-chicago-il-unit-1e/g8jc35492xnnz/');
    document.title = '953 E 61st St Unit 1E, Chicago, IL 60637 | Homes.com';
    document.body.innerHTML = `
      <h1>953 E 61st St Unit 1E</h1><div id="price">$250,000</div>
      <div class="ldp-property-info-container">
        <div class="property-info-feature"><span>2</span><span class="feature-beds">Beds</span></div>
        <div class="property-info-feature"><span>1</span><span class="feature-baths">Baths</span></div>
        <div class="property-info-feature"><span>1,000</span><span class="feature-sqft">Sq Ft</span></div>
      </div>
      <div id="amenities-container">
        <div class="subcategory"><h3 class="amenity-name">Home Type</h3><ul><li class="amenities-detail">Condominium</li></ul></div>
        <div class="subcategory"><h3 class="amenity-name">Year Built</h3><ul><li class="amenities-detail">Built in 1903</li></ul></div>
        <div class="subcategory"><h3 class="amenity-name">Tax Info</h3><ul>
          <li class="amenities-detail">Tax Annual Amount: 1308</li>
          <li class="amenities-detail">Tax Year: 2023</li>
        </ul></div>
      </div>
      <script type="application/ld+json">{"@graph":[{"@type":"RealEstateListing","url":"https://www.homes.com/property/x/g8jc35492xnnz/","name":"953 E 61st St Unit 1E, Chicago, IL 60637","offers":{"price":250000},"mainEntity":{}}]}</script>`;

    const details = HomesAdapter.extractFromDetailPage()!.details!;
    expect(details).toMatchObject({
      propertyType: 'Condominium', yearBuilt: 1903,
      tax: { annualAmount: 1308, year: 2023, sourceKind: 'listing-reported' }
    });
  });
});
