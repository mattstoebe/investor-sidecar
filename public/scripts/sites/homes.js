/**
 * Homes.com site adapter.
 *
 * Selectors here were measured live across 4 markets, 4 property types, 160 result cards
 * and 12 detail pages -- see docs/homes-com-feasibility.md, which is the recon record and
 * explains why each choice is the way it is. Homes.com is server-rendered Vue: the
 * `data-v-*` attributes are scoped-style markers that change per build and nothing here
 * touches them, but the readable class names are the stable surface (the same footing
 * Redfin is on, and better than Zillow's hashed names).
 *
 * Three things about this site produce confidently wrong numbers rather than visible
 * failures, so they are worth stating up front. A detail page embeds up to nine
 * similar/sold cards using the *identical* markup as a results card, which means:
 *  - `.price-container` on a detail page is a different property. Measured $399,900
 *    against a subject's $615,000, and "$180,000 Sold Feb 27, 2026" -- a sold comp --
 *    on another. The subject's price is `#price`.
 *  - `.detailed-info-container` on a detail page is also a comp. On a 420 sqft studio it
 *    read "2 Beds 2 Baths 1,000 Sq Ft". The subject's own facts live in
 *    `.ldp-property-info-container`, which does not contain that selector at all.
 *  - "Shoal Creek" contains a case-insensitive "hoa", so a loose fee scan matches every
 *    listing on that street. The anchored parseHoa handles it; keep it scoped anyway.
 *
 * This file is deliberately self-contained: the property-id rule and the "Studio" bed
 * count live here rather than in parsers.js, so adding this site needs no edit to a file
 * the other two adapters share. If parsers.js gains a homesPropertyId later, this should
 * defer to it.
 */
var HomesAdapter = (function () {
  const P = SidecarParsers;

  /**
   * Detail pages are /property/<slug>/<pk>/. The key is alphanumeric ("vff9j5680b68l"),
   * which is why this adapter declares isValidPropertyId below -- both existing sites
   * yield bare digits and content.js rejects anything else by default.
   *
   * Anchored at both ends so a results page can't match: /austin-tx/, its rental and
   * agent paths and /news/ all correctly yield null, while a detail path yields the key.
   */
  function homesPropertyId(pathname) {
    if (!pathname) return null;
    return pathname.match(/^\/property\/[^/]+\/([a-z0-9]+)\/?$/i)?.[1] ?? null;
  }

  /**
   * parseBedBathSqft, plus the one thing it can't know: Homes.com renders a studio as
   * "Studio" with no number, so the shared parser returns null for beds where the honest
   * answer is 0. Measured on Chicago condos ("Studio 1 Bath 420 Sq Ft").
   */
  function parseFacts(text) {
    const facts = P.parseBedBathSqft(text);
    if (facts.beds === null && /\bstudio\b/i.test(String(text ?? ''))) {
      return { ...facts, beds: '0' };
    }
    return facts;
  }

  /**
   * The listing's ld+json node, but only one that proves it describes this pk. Same
   * reasoning as the Zillow adapter: server-rendered head scripts survive SPA
   * navigations, so an unscoped read can pair the previous listing's price with this
   * one's address.
   *
   * Richest structured source of the three sites -- offers.price plus a mainEntity with
   * beds, floorSize, address and geo, so geo comes free here where Zillow needed a
   * scoped walk of __NEXT_DATA__.
   */
  function listingLdJson(propertyID) {
    if (!propertyID) return null;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch {
        continue; // a malformed blob shouldn't abort the lookup
      }
      // The payload is a single @graph on this site; tolerate the other two shapes.
      const nodes = parsed?.['@graph'] ?? (Array.isArray(parsed) ? parsed : [parsed]);
      for (const node of nodes) {
        const types = [].concat(node?.['@type'] ?? []).join(',');
        if (!types.includes('RealEstateListing')) continue;
        const identity = [node?.url, node?.['@id'], node?.offers?.url]
          .map((v) => String(v ?? ''))
          .join(' ');
        if (!identity.includes(propertyID)) continue;
        return node;
      }
    }
    return null;
  }

  /**
   * The subject property's own facts block. Returns nulls rather than reaching for
   * `.detailed-info-container`, which on a detail page belongs to a comp.
   *
   * Each fact is a `.property-info-feature` holding a value span followed by a label span
   * (`.property-info-feature-detail` "2.5" + `.feature-baths` "Baths"), so the pair's
   * combined text is what parses.
   */
  function subjectFacts() {
    const box = document.querySelector('.ldp-property-info-container');
    if (!box) return { beds: null, baths: null, sqft: null };

    const featureText = (labelSelector) => {
      const label = box.querySelector(labelSelector);
      if (!label) return null;
      const feature = label.closest('.property-info-feature') ?? label.parentElement;
      return feature?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    };

    const bedsText = featureText('.feature-beds');
    return {
      beds: bedsText === null
        ? null
        : (/\bstudio\b/i.test(bedsText) ? '0' : P.firstNumber(bedsText)),
      baths: P.firstNumber(featureText('.feature-baths')),
      sqft: P.firstNumber(featureText('.feature-sqft'))
    };
  }

  /** Prefers whichever candidate carries the state and ZIP the tax/rent services need. */
  function bestAddress(candidates) {
    const present = candidates.map((c) => c?.trim()).filter(Boolean);
    return present.find((c) => /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(c)) ?? present[0] ?? null;
  }

  /**
   * A card's price, without the label glued to it.
   *
   * On a sold search the container reads "$341,990 Last List Price" as one string --
   * Texas is a non-disclosure state, so Homes.com shows the last list price and says so
   * in a child span. Redfin is immune to this because its value and label are separate
   * elements; here they share a parent, and the whole string reaches parseMoney, which
   * requires the cleaned text to be entirely numeric and so rejects it. That turned every
   * sold-card capture into a house with no usable price.
   *
   * Cloned rather than read node-by-node so any future label element is dropped too, not
   * just the one spelling we've seen.
   */
  function cardPriceText(card) {
    // Sale and sold cards use .price-container, while live rental cards use
    // .current-price with a child .rent-indicator ("Per Month"). Keep that unit in
    // the text: parseCompAmount needs it to distinguish a rent comp from a sale price.
    const container = card?.querySelector('.price-container, .current-price');
    if (!container) return null;
    const clone = container.cloneNode(true);
    clone.querySelectorAll('span[class*="label"], .last-list-price-label').forEach((el) => el.remove());
    // `textContent` glues adjacent inline spans ("$2,300Per Month") when a card
    // omits source whitespace. The shared text walker preserves that semantic boundary.
    const text = P.separatedText(clone);
    return text || null;
  }

  const cardPk = (card) => card?.getAttribute('data-pk') || null;

  const cardHref = (card) =>
    card?.querySelector('a[href*="/property/"]')?.getAttribute('href')
    // Present on some markets and absent on others (Austin had it, Chicago didn't), so
    // it's the fallback rather than the source.
    ?? card?.getAttribute('data-detail-url')
    ?? null;

  /** Homes.com renders map selections in a Google Maps info window, not as a search
   * placard. Keep this extractor deliberately scoped to that popup: its selectors are
   * also common enough elsewhere on a detail page to pick up the wrong property. */
  function mapPopupHouse(popup) {
    const link = popup?.querySelector('a[data-pk][href*="/property/"]');
    if (!link) return null;
    const facts = parseFacts(P.separatedText(popup.querySelector('.property-info-container')));
    const address = [
      popup.querySelector('.property-address')?.textContent?.trim(),
      popup.querySelector('.property-city-state-zip')?.textContent?.trim()
    ].filter(Boolean).join(', ') || null;
    return {
      source: 'homes',
      address,
      price: P.separatedText(popup.querySelector('.property-price')) || null,
      beds: facts.beds,
      baths: facts.baths,
      sqft: facts.sqft,
      propertyID: link.getAttribute('data-pk') || homesPropertyId(P.pathnameOf(link.getAttribute('href'), window.location.origin)),
      url: P.absoluteUrl(link.getAttribute('href'), window.location.origin),
      latitude: null,
      longitude: null,
      hoa: null
    };
  }

  function mapPopupStatus(popup) {
    const evidence = P.separatedText(popup);
    if (/\b(?:per\s+month|for rent)\b/i.test(evidence)) return 'rental';
    if (/\bsold\b/i.test(evidence)) return 'sold';
    return 'active';
  }

  function mapPopupCompFacts(popup) {
    const house = mapPopupHouse(popup);
    if (!house) return null;
    return {
      amountText: house.price,
      priceLabel: null,
      soldDateText: P.separatedText(popup.querySelector('.status-pill'))
    };
  }

  function mapPopupCompEligible(popup, kind) {
    const facts = mapPopupCompFacts(popup);
    const parsed = P.parseCompAmount(facts?.amountText);
    if (!parsed || (kind === 'rent' && parsed.approximate)) return false;
    return kind === 'rent' ? parsed.monthly : !parsed.monthly;
  }

  return {
    id: 'homes',

    matchesHost(hostname) {
      return /(^|\.)homes\.com$/i.test(hostname);
    },

    /**
     * Opts this site out of content.js's digits-only default. Still rejects null, '' and
     * 'N/A' -- the cases that guard exists for -- and the length floor stops the id rule's
     * permissiveness (a hand-typed /property/foo/abc/ yields "abc") reaching storage.
     */
    isValidPropertyId(id) {
      return /^[a-z0-9]{6,}$/i.test(String(id ?? ''));
    },

    /**
     * URL-based, deliberately. A DOM check would misfire: detail pages contain up to nine
     * card elements, so anything keyed off card markup classifies them as results pages --
     * which is how Zillow ended up with no button on the subject and nine on the comps.
     */
    isDetailPage() {
      return Boolean(homesPropertyId(window.location.pathname));
    },

    listingStatusFromCard(card) {
      // A status pill is the only structural sold signal. Do this before the normal
      // for-sale class: sold results reuse that class in some Homes.com templates.
      if (card?.querySelector('.status-pill.tag-type-sold')) return 'sold';
      if (card?.classList.contains('for-rent-mls-placard')
        || card?.classList.contains('for-rent-apts-mf-placard')
        || /^per\s+month$/i.test(card?.querySelector('.rent-indicator')?.textContent?.replace(/\s+/g, ' ').trim() ?? '')) {
        return 'rental';
      }
      // Never infer sold status from a whole-card text scan here. An ordinary active
      // listing at 4158 S Campbell says "SOLD As-Is" in its marketing description;
      // that describes condition, not transaction status, and previously hid Analyze.
      if (card?.classList.contains('for-sale-placard')) return 'active';
      return null;
    },

    /**
     * Homes.com puts a rental and a for-sale listing on the same /property/... URL, and
     * its ld+json price is a bare number in both cases. The rendered unit beside #price
     * is the authoritative distinction: a live rental detail page has
     * `.property-info-rent-container .price-label` reading "Per Month". Scope this to
     * the price block so a lease term lower in the description cannot suppress a sale.
     */
    isRentalDetailPage() {
      const rentUnit = document.querySelector('.property-info-rent-container .price-label');
      return /^per\s+month$/i.test(rentUnit?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
    },

    /**
     * Verified rendered down to a 256px viewport -- narrower than the side panel's 320px
     * floor -- so unlike Zillow there is no mobile action bar to fall back to. The later
     * entries are for listing states this recon didn't cover.
     */
    detailInjectionTarget() {
      const target = P.firstUsable([
        document.querySelector('.property-info-user-actions'),
        document.querySelector('.property-info-price-and-icons'),
        document.querySelector('.property-info-address'),
        document.querySelector('h1')?.parentElement
      ]);
      if (!target) return null;

      // Beside the favourite control when it's a direct child, so we inherit its
      // alignment in the row instead of trailing whatever happens to be last.
      const favorite = target.querySelector('.favorite-button');
      const sibling = favorite?.parentElement === target ? favorite : null;
      return { container: target, insertAfter: sibling, position: 'append' };
    },

    extractFromDetailPage() {
      const propertyID = homesPropertyId(window.location.pathname);
      if (!propertyID) return null;

      const ld = listingLdJson(propertyID);
      const entity = ld?.mainEntity ?? null;

      // Structured price first -- a real number rather than rendered text -- but only from
      // a blob proven to be this listing. The DOM fallback is not decorative: a Cleveland
      // multi-family carried no `offers` at all and #price gave $139,900. It must be
      // #price itself and not its parent, which reads "$134,500 $6K PRICE DROP" and
      // parseMoney correctly refuses.
      const ldPrice = Number(ld?.offers?.price);
      const price = Number.isFinite(ldPrice) && ldPrice > 0
        ? String(ldPrice)
        : document.getElementById('price')?.textContent?.trim() ?? null;

      // ld+json's name is usually "street, city, ST ZIP" but is sometimes street-only
      // ("11101 Nelson Ave"), where the title carried the full address -- so neither wins
      // by default. The h1 is street-only and whitespace-padded.
      const address = bestAddress([
        ld?.name,
        document.title.split('|')[0],
        document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ')
      ]);

      // Rendered facts win over the structured blob for baths specifically:
      // numberOfBathroomsTotal reported 2 where the listing renders "2.5 Baths", and a
      // dropped half-bath silently moves DSCR. Beds and sqft agreed everywhere measured,
      // including numberOfBedrooms 0 for a studio, so ld+json backs them up.
      const facts = subjectFacts();
      const floorSize = entity?.floorSize?.value;
      const beds = facts.beds
        ?? (entity?.numberOfBedrooms != null ? String(entity.numberOfBedrooms) : null);
      const baths = facts.baths
        ?? (entity?.numberOfBathroomsTotal != null ? String(entity.numberOfBathroomsTotal) : null);
      const sqft = facts.sqft ?? (floorSize != null ? String(floorSize) : null);

      // Scoped to the subject's own amenities section. A whole-page scan would reach a
      // comp's fee, and this page's text also contains "Shoal Creek".
      const amenities = document.querySelector('#amenities-container');
      const hoa = amenities ? P.parseHoa(amenities.textContent) : null;

      const latitude = Number(entity?.geo?.latitude);
      const longitude = Number(entity?.geo?.longitude);

      if (!address || !price) return null;

      return {
        source: 'homes',
        address,
        price,
        beds,
        baths,
        sqft,
        propertyID,
        url: window.location.href,
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        hoa
      };
    },

    findCardElements() {
      return [...document.querySelectorAll('article.search-placard[data-pk]')];
    },

    isInjectableCard(card) {
      if (!card || !cardPk(card)) return false;
      return Boolean(card.querySelector('address, .address')
        || card.querySelector('.price-container, .current-price'));
    },

    cardInjectionTarget(card) {
      // The row holding the card's own heart and kebab. Measured: our button lands on the
      // same baseline, inside the card, with nothing covering it.
      const actions = card.querySelector('.placard-user-actions-container');
      if (actions) {
        const favorite = actions.querySelector('.favorite-button');
        return {
          container: actions,
          insertAfter: favorite?.parentElement === actions ? favorite : null
        };
      }
      const price = card.querySelector('.price-container, .current-price');
      if (price?.parentElement) return { container: price.parentElement, insertAfter: price };
      return { container: card, insertAfter: null };
    },

    extractFromCard(card) {
      if (!card) return null;

      // Scoped to the stats list, NOT the whole card. Homes.com inlines
      // <script type="text/template"> carousel templates inside each article, and a
      // TreeWalker over the card returns that raw markup as text -- so the whole-card
      // separatedText() the Zillow adapter uses would be parsing HTML here.
      const facts = parseFacts(P.separatedText(card.querySelector('.detailed-info-container')));
      const href = cardHref(card);

      return {
        source: 'homes',
        // Both give the full address including state and ZIP, unlike Zillow's cards.
        address: card.querySelector('address, .address')?.textContent?.trim()
          ?? card.getAttribute('data-listing-title')
          ?? null,
        price: cardPriceText(card),
        beds: facts.beds,
        baths: facts.baths,
        sqft: facts.sqft,
        // data-pk is the same key the detail URL ends with -- checked against all 40 cards
        // on a results page with zero mismatches -- so a card capture and a detail capture
        // of one property dedupe to the same houseKey.
        propertyID: cardPk(card) ?? homesPropertyId(P.pathnameOf(href, window.location.origin)),
        url: P.absoluteUrl(href, window.location.origin),
        // Cards carry neither geo nor fee, on any of the three sites. The panel surfaces
        // the missing rent estimate rather than the capture failing.
        latitude: null,
        longitude: null,
        hoa: null
      };
    },

    /**
     * Comp-mode extras for a results-page card. See docs/comp-workflow.md §3.
     *
     * Better equipped than either existing site. The sold date has a dedicated selector
     * -- span.status-pill.tag-type-sold, measured as "Sold Mar 11, 2026" -- where Redfin
     * and Zillow both hand back the whole card's text for the caller to hunt through. It
     * is still passed as soldDateText rather than a parsed date, because the contract is
     * "text the caller pulls a date out of" and a lone pill is a strict improvement on
     * that input, not a different shape.
     *
     * priceLabel is Homes.com's own words: "Last List Price" on a sold card in a
     * non-disclosure state, which is exactly the case Comp.amountLabel's 'last-list'
     * value exists for. amountText excludes that label -- see cardPriceText.
     */
    compFacts(card) {
      if (!card) return null;
      return {
        amountText: cardPriceText(card),
        priceLabel: card.querySelector('.price-container .last-list-price-label')?.textContent?.trim() ?? null,
        soldDateText: card.querySelector('.status-pill.tag-type-sold')?.textContent?.trim()
          ?? P.separatedText(card.querySelector('.detailed-info-container'))
      };
    },

    extraInjectionTargets() {
      const extras = [];
      for (const popup of document.querySelectorAll('.gm-style-iw .click-card-container')) {
        const container = popup.querySelector('.top-line-container');
        const link = popup.querySelector('a[data-pk][href*="/property/"]');
        if (!container || !link) continue;
        const favorite = container.querySelector('.favorite-button');
        extras.push({
          container,
          insertAfter: favorite?.parentElement === container ? favorite : null,
          className: 'bp-CalculatorExtension sidecar-Button--icon sidecar-MapPopupCalculator',
          extract: () => mapPopupHouse(popup),
          listingStatus: () => mapPopupStatus(popup),
          compFacts: () => mapPopupCompFacts(popup),
          isCompEligible: (kind) => mapPopupCompEligible(popup, kind),
          missingDataReason: "Couldn't read this map listing's details."
        });
      }
      return extras;
    },

    // Homes.com's own button classes are semantic but tied to its own layout, so the
    // button carries only our classes and relies on the self-contained styles in
    // content.js -- the same choice the Zillow adapter makes.
    cardButtonClassName: 'bp-CalculatorExtension sidecar-Button--icon',
    detailButtonClassName: 'bp-CalculatorExtension sidecar-Button--action',
    detailWrapperClassName: 'sidecar-ActionWrapper',

    diagnostics() {
      const pk = homesPropertyId(window.location.pathname);
      return {
        cards: this.findCardElements().length,
        detailPage: this.isDetailPage(),
        detailTarget: !!this.detailInjectionTarget(),
        pk,
        hasLdJson: !!listingLdJson(pk),
        subjectFacts: subjectFacts()
      };
    }
  };
})();
