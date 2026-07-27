import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

/**
 * Loads public/scripts/sites/parsers.js -- the actual file the extension ships --
 * into a sandbox and tests it directly. The previous property-id test mirrored the
 * helpers by hand, which meant the test could pass while the shipped code drifted.
 */
function loadParsers() {
  const file = resolve(__dirname, '../public/scripts/sites/parsers.js');
  // URL is a browser global the parsers rely on; a fresh vm context has no globals.
  const sandbox: Record<string, unknown> = { module: { exports: {} }, URL };
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.SidecarParsers as {
    redfinPropertyId(p: string | null | undefined): string | null;
    zillowPropertyId(p: string | null | undefined): string | null;
    parseBedBathSqft(t: string | null | undefined): { beds: string | null; baths: string | null; sqft: string | null };
    separatedText(root: Element | null | undefined): string;
    parseHoa(t: string | null | undefined): number | null;
    firstNumber(t: string | null | undefined): string | null;
    absoluteUrl(h: string | null | undefined, o: string): string | null;
    pathnameOf(h: string | null | undefined, o: string): string | null;
  };
}

const P = loadParsers();

describe('redfinPropertyId', () => {
  // All of these appear together on one live WA results page.
  it.each([
    ['/WA/Shoreline/322-NW-200th-St-98177/for-sale/77753', '77753'],
    ['/WA/Bothell/2804-232nd-St-SE-98021/for-sale/2915987', '2915987'],
    ['/WA/Redmond/6742-137th-Ave-NE-98052/unit-426/home/71857', '71857'],
    ['/TX/Dallas/12108-Fieldwood-Ln-75244/home/30926649', '30926649'],
    ['/WA/Spokane-Valley/701-S-Felts-Rd-99206/unit-B102/apartment/191566056', '191566056']
  ])('extracts %s', (path, expected) => {
    expect(P.redfinPropertyId(path)).toBe(expected);
  });

  it('tolerates a trailing slash', () => {
    expect(P.redfinPropertyId('/WA/Shoreline/322-NW-200th-St-98177/for-sale/77753/')).toBe('77753');
  });

  it('does not mistake a zip in the address slug for an id', () => {
    expect(P.redfinPropertyId('/WA/Shoreline/322-NW-200th-St-98177')).toBeNull();
  });

  it.each([null, undefined, '', '/'])('returns null for %s', (input) => {
    expect(P.redfinPropertyId(input as string)).toBeNull();
  });
});

describe('zillowPropertyId', () => {
  it('extracts the zpid', () => {
    expect(P.zillowPropertyId('/homedetails/1615-N-196th-Pl-Shoreline-WA-98133/48703301_zpid/')).toBe('48703301');
  });

  it('works without the trailing slash', () => {
    expect(P.zillowPropertyId('/homedetails/1615-N-196th-Pl-Shoreline-WA-98133/48703301_zpid')).toBe('48703301');
  });

  // The two rules must not be interchangeable -- that assumption caused the
  // "can't find the house page" bug on Redfin's /for-sale/ URLs.
  it('is not interchangeable with the Redfin rule', () => {
    const zillow = '/homedetails/1615-N-196th-Pl-Shoreline-WA-98133/48703301_zpid/';
    const redfin = '/WA/Shoreline/322-NW-200th-St-98177/for-sale/77753';

    expect(P.redfinPropertyId(zillow)).toBeNull();   // trailing segment is "48703301_zpid"
    expect(P.zillowPropertyId(zillow)).toBe('48703301');

    expect(P.zillowPropertyId(redfin)).toBeNull();   // no _zpid marker
    expect(P.redfinPropertyId(redfin)).toBe('77753');
  });

  it.each([null, undefined, '', '/shoreline-wa/'])('returns null for %s', (input) => {
    expect(P.zillowPropertyId(input as string)).toBeNull();
  });
});

describe('parseBedBathSqft', () => {
  it('parses Zillow\'s unpunctuated detail-page string', () => {
    // Observed verbatim on a live Zillow detail page.
    expect(P.parseBedBathSqft('3beds2baths1,400sqft')).toEqual({ beds: '3', baths: '2', sqft: '1400' });
  });

  it('parses Redfin\'s spaced card stats', () => {
    expect(P.parseBedBathSqft('3 beds 2.5 baths 1,850 sq ft')).toEqual({ beds: '3', baths: '2.5', sqft: '1850' });
  });

  it('handles the abbreviated form', () => {
    expect(P.parseBedBathSqft('4 bd 3 ba 2,380 sq ft')).toEqual({ beds: '4', baths: '3', sqft: '2380' });
  });

  it('keeps fractional baths', () => {
    expect(P.parseBedBathSqft('6 beds 6.5 baths 5,516 sq ft').baths).toBe('6.5');
  });

  /**
   * Strings captured verbatim off a live Zillow results page. textContent glued each card's
   * price to its bed count, and the parser reported the price's trailing digits as the bed
   * count on every card: "0002", "0004", and worst of all "9993" for a $569,999 3-bed.
   * Returning null here is the fail-closed behaviour -- separatedText is what supplies the
   * real value, and the adapter test covers that end of it.
   */
  it.each([
    '$750,0002 bds3 ba2,100 sqftActive',
    '$550,0004 bds2 ba2,079 sqftPending',
    '$569,9993 bds2 ba1,650 sqftActive'
  ])('refuses to read a bed count glued to a price: %s', (text) => {
    // Specifically not the price's trailing digits, which is what it used to return.
    expect(P.parseBedBathSqft(text).beds).toBeNull();
  });

  it('still reads sqft that follows a letter, not a digit', () => {
    // "3 ba2,100 sqft" -- the comma-bearing group is preceded by "a", which is fine.
    expect(P.parseBedBathSqft('3 ba 2,100 sqft').sqft).toBe('2100');
  });

  it('returns null for pieces that are absent, not a sentinel string', () => {
    expect(P.parseBedBathSqft('3 beds')).toEqual({ beds: '3', baths: null, sqft: null });
    expect(P.parseBedBathSqft('')).toEqual({ beds: null, baths: null, sqft: null });
    expect(P.parseBedBathSqft(null)).toEqual({ beds: null, baths: null, sqft: null });
  });

  // Each of these broke one of the two guard styles: \b fails when a digit follows
  // (Zillow's unpunctuated string), and no guard at all matches inside "bedroom".
  it.each([
    ['3beds2baths1,400sqft', '3', '2', '1400'],
    ['3 bds 2 ba 1,400 sqft', '3', '2', '1400'],
    ['2 beds2 baths1,765 sq ft', '2', '2', '1765'],
    ['4 bd 3 ba 2,380 sq ft', '4', '3', '2380']
  ])('parses %s', (text, beds, baths, sqft) => {
    expect(P.parseBedBathSqft(text)).toEqual({ beds, baths, sqft });
  });

  it('does not match inside longer words like bedroom or bathroom', () => {
    expect(P.parseBedBathSqft('3 bedroom house').beds).toBeNull();
    expect(P.parseBedBathSqft('2 bathroom remodel').baths).toBeNull();
  });

  it('strips thousands separators from sqft so it parses as a number', () => {
    expect(Number(P.parseBedBathSqft('3beds2baths10,500sqft').sqft)).toBe(10500);
  });
});

describe('parseHoa', () => {
  it.each([
    ['$250 HOA', 250],
    ['HOA: $145/mo', 145],
    ['$1,200 monthly HOA', 1200],
    ['HOA Dues $85', 85],
    ['HOA fee: $250 monthly', 250],
    ['Monthly HOA fee: $425', 425],
    ['HOA fee: 250', 250],
    ['HOA assessment: $310', 310]
  ])('parses %s', (text, expected) => {
    expect(P.parseHoa(text)).toBe(expected);
  });

  it('returns null when there is no HOA mentioned', () => {
    expect(P.parseHoa('3 beds 2 baths')).toBeNull();
    expect(P.parseHoa('')).toBeNull();
    expect(P.parseHoa(null)).toBeNull();
  });

  /**
   * Regression: reported on a live Chicago listing with no HOA. The old loose
   * fallback /HOA[^$\d]*\$?([\d,]+)/ matched Zillow's "Community & HOA" section
   * heading, skipped ~150 characters of unrelated text because [^$\d]* is
   * unbounded, and returned 820000 -- an $820,000/month HOA on a house whose
   * facts read "HOA Services included: None".
   */
  it('does not invent an HOA from a section heading and a distant number', () => {
    const liveText = 'fficient items: Water HeaterCommunity & HOACommunityFeatures: Curbs, '
      + 'Sidewalks, Street Lights, Street PavedSecurity: Carbon Monoxide Detector(s)'
      + 'HOAServices included: NoneLocationRegion: ChicagoFinancial & 820,000';
    expect(P.parseHoa(liveText)).toBeNull();
  });

  it.each([
    'Community & HOA',
    'HOAServices included: None',
    'HOA: None',
    'Has HOA: No'
  ])('treats %s as no HOA rather than guessing', (text) => {
    expect(P.parseHoa(text)).toBeNull();
  });

  // Overstating expenses turns a good deal into a bad one on screen, so an
  // ambiguous match must resolve to null, never to an arbitrary nearby number.
  it('will not reach across unrelated content for a number', () => {
    expect(P.parseHoa('HOA information available upon request. List price $820,000')).toBeNull();
  });
});

describe('firstNumber', () => {
  it('strips a unit suffix, as needed for Redfin\'s abp-baths cell', () => {
    // That cell renders "6.5 ba" directly rather than wrapping the value.
    expect(P.firstNumber('6.5 ba')).toBe('6.5');
  });

  it('strips thousands separators', () => {
    expect(P.firstNumber('5,516')).toBe('5516');
    expect(P.firstNumber('$2,799,999')).toBe('2799999');
  });

  it('returns null when there is no number', () => {
    expect(P.firstNumber('N/A')).toBeNull();
    expect(P.firstNumber(null)).toBeNull();
  });
});

describe('absoluteUrl / pathnameOf', () => {
  it('resolves a relative listing href', () => {
    expect(P.absoluteUrl('/TX/Dallas/home/123', 'https://www.redfin.com'))
      .toBe('https://www.redfin.com/TX/Dallas/home/123');
  });

  it('leaves an absolute href intact', () => {
    expect(P.absoluteUrl('https://www.zillow.com/homedetails/x/9_zpid/', 'https://www.zillow.com'))
      .toBe('https://www.zillow.com/homedetails/x/9_zpid/');
  });

  it('extracts a pathname for id parsing', () => {
    expect(P.pathnameOf('https://www.zillow.com/homedetails/x/48703301_zpid/', 'https://www.zillow.com'))
      .toBe('/homedetails/x/48703301_zpid/');
  });

  it('returns null rather than throwing on unusable input', () => {
    expect(P.absoluteUrl(null, 'https://www.redfin.com')).toBeNull();
    expect(P.absoluteUrl('', 'https://www.redfin.com')).toBeNull();
  });
});

/**
 * separatedText needs a DOM, unlike the rest of this file's pure helpers. It exists because
 * element.textContent has no separator between sibling elements, which is what produced the
 * glued "$750,0002 bds" strings the parser cases above document.
 */
describe('separatedText', () => {
  const el = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
  };

  it('keeps sibling elements apart where textContent runs them together', () => {
    // The shape of a Zillow results card: price and facts are separate elements.
    const card = el('<span>$750,000</span><ul><li>2 bds</li><li>3 ba</li><li>2,100 sqft</li></ul>');
    expect(card.textContent).toBe('$750,0002 bds3 ba2,100 sqft');
    expect(P.separatedText(card)).toBe('$750,000 2 bds 3 ba 2,100 sqft');
  });

  it('leaves an unpunctuated single text node alone', () => {
    // Zillow's detail page really does render this as one string; splitting it is not our job.
    const facts = el('<div>3beds2baths1,400sqft</div>');
    expect(P.separatedText(facts)).toBe('3beds2baths1,400sqft');
  });

  it('drops whitespace-only nodes rather than emitting blank gaps', () => {
    const card = el('<span>2 bds</span>\n   \n<span>3 ba</span>');
    expect(P.separatedText(card)).toBe('2 bds 3 ba');
  });

  it('returns an empty string for a missing element instead of throwing', () => {
    expect(P.separatedText(null)).toBe('');
    expect(P.separatedText(undefined)).toBe('');
  });
});
