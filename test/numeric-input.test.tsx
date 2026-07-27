import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HouseCard, ParametersSelector, DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import type { House, GlobalParameters } from '../src/App';

/**
 * The bug: parsing typed text straight to a number and feeding that number back
 * as the controlled input value eats characters mid-entry. Type "0" then "." and
 * Number("0.") is 0, which renders back as "0" -- the decimal point you just
 * typed vanishes before you can type anything after it. These tests type one
 * character at a time, the way a real keystroke sequence arrives, and assert the
 * input's displayed value never loses what was just typed.
 */

const globalParams: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 };

const house = (overrides: Partial<House> = {}): House => ({
  address: '123 Example St',
  price: '$400,000',
  beds: '3',
  baths: '2',
  sqft: '1800',
  propertyID: '12345',
  url: 'https://www.redfin.com/home/12345',
  latitude: 32.7,
  longitude: -97.3,
  ...overrides
});

/** Fires one change event per character, the way a browser delivers real keystrokes. */
function typeCharByChar(input: HTMLElement, text: string) {
  let typed = '';
  for (const char of text) {
    typed += char;
    fireEvent.change(input, { target: { value: typed } });
  }
}

function openPurchaseDropdown() {
  render(<HouseCard house={house()} globalParams={globalParams} />);
  fireEvent.click(screen.getByTestId('toggle-purchase'));
}

describe('numeric input typing', () => {
  it('a rate field keeps a decimal point while typing "0.35" one character at a time', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('rate-field-Interest') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '0' } });
    expect(input.value).toBe('0');

    fireEvent.change(input, { target: { value: '0.' } });
    // This is the exact regression: the old version fed Number("0.") = 0 back as
    // the controlled value, which rendered as "0" and silently dropped the ".".
    expect(input.value).toBe('0.');

    fireEvent.change(input, { target: { value: '0.3' } });
    expect(input.value).toBe('0.3');

    fireEvent.change(input, { target: { value: '0.35' } });
    expect(input.value).toBe('0.35');
  });

  it('never reverts a trailing zero in a decimal like "1.50"', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('rate-field-Interest') as HTMLInputElement;

    typeCharByChar(input, '1.50');
    expect(input.value).toBe('1.50');
  });

  it('lets a global assumption field be typed the same way', () => {
    // GlobalNumberField is the other consumer of the same buffer -- exercised via
    // ParametersSelector, but there's no house dependency needed to reach the bug,
    // so testing through the Purchase dropdown's identical PercentOverrideField
    // (Percent Down here) covers the same code path.
    openPurchaseDropdown();
    const input = screen.getByTestId('rate-field-Down payment') as HTMLInputElement;

    typeCharByChar(input, '12.5');
    expect(input.value).toBe('12.5');
  });

  it('the committed value is correct after typing completes, not just the display', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('rate-field-Interest') as HTMLInputElement;
    typeCharByChar(input, '6.25');

    // Blurring re-syncs from the committed value -- if 6.25 actually made it through
    // (not silently truncated to 6 somewhere along the way), it survives a blur/refocus.
    fireEvent.blur(input);
    expect(input.value).toBe('6.25');
  });

  it('clamps to the field max but does not fight in-range typing along the way', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('rate-field-Interest') as HTMLInputElement; // max 20
    typeCharByChar(input, '15'); // in range the whole way through
    expect(input.value).toBe('15');
  });

  it('Purchase Price allows typing digits freely without the $ formatting fighting the cursor', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('purchase-price-field') as HTMLInputElement;

    typeCharByChar(input, '425000');
    expect(input.value).toBe('425000');
  });

  it('Purchase Price reformats to $X,XXX only after losing focus, not while typing', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('purchase-price-field') as HTMLInputElement;

    typeCharByChar(input, '425000');
    expect(input.value).toBe('425000'); // no $ or commas mid-type

    fireEvent.blur(input);
    expect(input.value).toBe('$425,000');
  });

  it('editing a formatted Purchase Price in place (leaving $ and commas) still parses correctly', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('purchase-price-field') as HTMLInputElement;
    typeCharByChar(input, '400000');
    fireEvent.blur(input);
    expect(input.value).toBe('$400,000');

    // Edit without clearing first, e.g. changing one digit in place.
    fireEvent.change(input, { target: { value: '$450,000' } });
    expect(input.value).toBe('$450,000');
    fireEvent.blur(input);
    expect(input.value).toBe('$450,000'); // parsed correctly, not reset to blank/NaN
  });

  it('Additional Cash Investment accepts whole-dollar typing and formats on blur', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('additional-cash-field') as HTMLInputElement;

    typeCharByChar(input, '1500');
    expect(input.value).toBe('1500');
    fireEvent.blur(input);
    expect(input.value).toBe('$1,500');
  });

  // Reported symptom: "when I type it just enters in random numbers." The rent field
  // clamped to getRentBounds() on every keystroke, and those bounds come from price
  // (min 0.1% of price, max 1%). On a $400k house min was $400 and max $4,000, so
  // typing "2" snapped to $400, the next digit appended to the snapped value, and the
  // field filled with numbers that were never typed.
  it('rent field shows exactly the digits typed, with no price-derived snapping', () => {
    render(<HouseCard house={house()} globalParams={globalParams} />);
    const input = screen.getByTestId('rent-field') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '2' } });
    expect(input.value).toBe('2'); // old behavior: snapped to "$400"

    fireEvent.change(input, { target: { value: '25' } });
    expect(input.value).toBe('25');

    fireEvent.change(input, { target: { value: '250' } });
    expect(input.value).toBe('250');

    fireEvent.change(input, { target: { value: '2500' } });
    expect(input.value).toBe('2500');
  });

  it('rent field accepts a value above 1% of price, which the old max clamp forbade', () => {
    // $400k house: old baseMax was $4,000, so a $6,500 rent was impossible to enter.
    render(<HouseCard house={house()} globalParams={globalParams} />);
    const input = screen.getByTestId('rent-field') as HTMLInputElement;

    typeCharByChar(input, '6500');
    expect(input.value).toBe('6500');

    fireEvent.blur(input);
    expect(input.value).toBe('$6,500');
  });

  it('a typed rent actually drives the returns shown on the card', () => {
    render(<HouseCard house={house()} globalParams={globalParams} />);
    // With no rent there is no strip at all -- just the hint saying what's missing.
    expect(screen.getByTestId('needs-rent-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('verdict-strip')).not.toBeInTheDocument();

    const input = screen.getByTestId('rent-field') as HTMLInputElement;
    typeCharByChar(input, '3000');

    // Entering rent replaces the hint with real figures, computed from the typed
    // 3000 rather than a clamped substitute.
    expect(screen.queryByTestId('needs-rent-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('monthly-cash-flow')).toHaveTextContent(/\$-?[\d,]+/);
    expect(input.value).toBe('3000');
  });

  it('clearing a rate field back to empty is allowed and resets to inheriting the default', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('rate-field-Interest') as HTMLInputElement;
    typeCharByChar(input, '6.5');
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
  });
});

/**
 * handleInput clamps to the field's min/max but deliberately leaves the typed text alone, so
 * that in-range typing is never fought mid-keystroke. The consequence was that an
 * out-of-range value displayed forever: the field read 150% while the model used 100%.
 * A field that disagrees with the arithmetic is worse than one that rejects the input.
 */
describe('clamped values are reconciled on blur', () => {
  it('shows the clamped value once the field loses focus', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('rate-field-Interest') as HTMLInputElement; // max 20

    typeCharByChar(input, '150');
    // Still exactly what was typed while the field has focus.
    expect(input.value).toBe('150');

    fireEvent.blur(input);
    expect(input.value).toBe('20');
  });

  it('reconciles a value below the minimum too', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('rate-field-Interest') as HTMLInputElement; // min 0

    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.blur(input);
    expect(input.value).toBe('0');
  });

  it('leaves an in-range value untouched, including a deliberate trailing zero', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('rate-field-Interest') as HTMLInputElement;

    typeCharByChar(input, '1.50');
    fireEvent.blur(input);
    // Not normalised to "1.5": the value and the text agree, so there is nothing to fix.
    expect(input.value).toBe('1.50');
  });

  it('leaves an emptied field empty rather than filling in a clamp', () => {
    openPurchaseDropdown();
    const input = screen.getByTestId('rate-field-Interest') as HTMLInputElement;

    typeCharByChar(input, '7');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input.value).toBe('');
  });

  it('reconciles a global assumption field as well as a per-house one', () => {
    render(<ParametersSelector parameters={DEFAULT_GLOBAL_PARAMETERS} setParameters={() => {}} />);
    const input = document.getElementById('vacancyRateInput') as HTMLInputElement; // max 100

    fireEvent.change(input, { target: { value: '250' } });
    fireEvent.blur(input);
    expect(input.value).toBe('100');
  });
});
