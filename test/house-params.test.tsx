import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HouseCard, DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import type { House, GlobalParameters } from '../src/App';

/**
 * The three things useHouseParams arbitrates: when an edit reaches storage, whether an
 * incoming write replaces what is on screen, and how a card tells its own write apart from
 * everyone else's.
 *
 * The last one is why `writer` exists. Before, card state was set in useState initializers
 * under a stable key, so it was written once at mount and never again -- which made the card
 * unable to see an undo or an enrichment merge, and simultaneously immune to its own echo.
 * Adopting incoming props fixes the first and creates the second: without an identity check
 * a card would adopt the broadcast caused by its own save, reverting whatever was typed while
 * that save was in flight.
 */

const globalParams: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 };

const localParams = (overrides: Partial<NonNullable<House['localParams']>> = {}) => ({
  percentDown: null, interestRate: null, price: null,
  additionalCashInvestment: 0, sliderValue: 2000, propertyTaxRate: null,
  vacancyRate: null, maintenanceRate: null, capExRate: null,
  managementRate: null, insuranceRate: null,
  ...overrides
}) as NonNullable<House['localParams']>;

const house = (overrides: Partial<House> = {}): House => ({
  address: '123 Example St, Fort Worth, TX 76179',
  price: '$425,000',
  beds: '3', baths: '2', sqft: '1800',
  propertyID: '12345',
  url: 'https://www.redfin.com/TX/Fort-Worth/123-Example-St/home/12345',
  latitude: 32.7, longitude: -97.3,
  localParams: localParams(),
  ...overrides
});

const ready = () => {
  vi.mocked(chrome.runtime.sendMessage).mockClear();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true, saved: true });
};

const updates = () =>
  vi.mocked(chrome.runtime.sendMessage).mock.calls
    .map(([msg]) => msg as { action?: string; writer?: string; localParams?: Record<string, unknown> })
    .filter((msg) => msg?.action === 'updateLocalParams');

describe('save cadence', () => {
  /**
   * Every field used to send on every keystroke, and the worker broadcasts the whole house
   * list on every mutation -- so one four-digit rent cost four writes and four full-board
   * re-renders. It also made one edit worth four undo entries.
   */
  it('coalesces a burst of keystrokes into a single write', async () => {
    ready();
    render(<HouseCard house={house()} globalParams={globalParams} />);
    const field = screen.getByTestId('rent-field');

    for (const value of ['3', '31', '310', '3100']) {
      fireEvent.change(field, { target: { value } });
    }

    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0].localParams?.sliderValue).toBe(3100);
  });

  /** Leaving a field is the boundary a user reads as "done"; waiting out the debounce there
   *  would be a needless delay before the number is safe. */
  it('flushes immediately on blur rather than waiting out the debounce', async () => {
    ready();
    render(<HouseCard house={house()} globalParams={globalParams} />);
    const field = screen.getByTestId('rent-field');

    fireEvent.change(field, { target: { value: '2750' } });
    fireEvent.blur(field);

    // Well inside SAVE_DEBOUNCE_MS, so only the blur can explain this having been sent.
    await waitFor(() => expect(updates()).toHaveLength(1), { timeout: 120 });
    expect(updates()[0].localParams?.sliderValue).toBe(2750);
  });

  it('stamps writes with a writer id so the worker can attribute them', async () => {
    ready();
    render(<HouseCard house={house()} globalParams={globalParams} />);
    fireEvent.change(screen.getByTestId('rent-field'), { target: { value: '3100' } });

    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0].writer).toEqual(expect.any(String));
  });

  it('still sends nothing on mount', async () => {
    ready();
    render(<HouseCard house={house()} globalParams={globalParams} />);
    await new Promise((r) => setTimeout(r, 600));
    expect(updates()).toHaveLength(0);
  });
});

describe('adopting writes from elsewhere', () => {
  /**
   * The case that motivated all of this: an undo, or an enrichment merge, changes storage
   * while the card is mounted. Before, a card could not see it at all.
   */
  it('adopts a newer revision written by someone else', async () => {
    ready();
    const initial = house({ rev: 1 });
    const { rerender } = render(<HouseCard house={initial} globalParams={globalParams} />);
    expect(screen.getByTestId('rent-field')).toHaveValue('$2,000');

    rerender(
      <HouseCard
        house={{ ...initial, rev: 2, lastWriter: 'undo', localParams: localParams({ sliderValue: 4200 }) }}
        globalParams={globalParams}
      />
    );

    await waitFor(() => expect(screen.getByTestId('rent-field')).toHaveValue('$4,200'));
  });

  /**
   * The echo. The card's own save comes back as a broadcast; adopting it would revert any
   * keystroke landed between sending and receiving -- the same class of bug the text buffer
   * already guards one field at a time.
   */
  it('ignores the echo of its own write, keeping what was typed since', async () => {
    ready();
    const initial = house({ rev: 1 });
    const { rerender } = render(<HouseCard house={initial} globalParams={globalParams} />);

    fireEvent.change(screen.getByTestId('rent-field'), { target: { value: '3100' } });
    await waitFor(() => expect(updates()).toHaveLength(1));
    const writer = updates()[0].writer!;

    // The user keeps typing while that save is in flight.
    fireEvent.change(screen.getByTestId('rent-field'), { target: { value: '3600' } });

    // ...and the earlier save's broadcast now arrives, carrying the older value.
    rerender(
      <HouseCard
        house={{ ...initial, rev: 2, lastWriter: writer, localParams: localParams({ sliderValue: 3100 }) }}
        globalParams={globalParams}
      />
    );

    await new Promise((r) => setTimeout(r, 50));
    // Unformatted because the field never lost focus -- the buffer only applies $ and commas
    // on blur. What matters is that it reads 3600 and not the echoed 3100.
    expect(screen.getByTestId('rent-field')).toHaveValue('3600');
  });

  /** A broadcast the card has already passed is not news; re-adopting it would undo newer local edits. */
  it('ignores a revision that is not newer than the one it has', async () => {
    ready();
    const initial = house({ rev: 5 });
    const { rerender } = render(<HouseCard house={initial} globalParams={globalParams} />);

    rerender(
      <HouseCard
        house={{ ...initial, rev: 5, lastWriter: 'someone', localParams: localParams({ sliderValue: 9999 }) }}
        globalParams={globalParams}
      />
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('rent-field')).toHaveValue('$2,000');
  });

  /** Records predating revisions carry no rev at all; they must still render, not crash. */
  it('treats a missing revision as zero rather than failing', async () => {
    ready();
    const initial = house();
    delete initial.rev;
    const { rerender } = render(<HouseCard house={initial} globalParams={globalParams} />);

    rerender(
      <HouseCard
        house={{ ...initial, rev: 1, lastWriter: 'undo', localParams: localParams({ sliderValue: 3300 }) }}
        globalParams={globalParams}
      />
    );

    await waitFor(() => expect(screen.getByTestId('rent-field')).toHaveValue('$3,300'));
  });

  /**
   * A foreign write wins outright, pending local edit included. Keeping the edit would
   * re-send a value the user has just watched be replaced -- which is how an undo comes
   * straight back a moment after it lands.
   */
  it('drops a pending edit rather than re-sending it over a foreign write', async () => {
    ready();
    const initial = house({ rev: 1 });
    const { rerender } = render(<HouseCard house={initial} globalParams={globalParams} />);

    fireEvent.change(screen.getByTestId('rent-field'), { target: { value: '5000' } });
    rerender(
      <HouseCard
        house={{ ...initial, rev: 2, lastWriter: 'undo', localParams: localParams({ sliderValue: 2000 }) }}
        globalParams={globalParams}
      />
    );

    await new Promise((r) => setTimeout(r, 600));
    expect(updates()).toHaveLength(0);
    expect(screen.getByTestId('rent-field')).toHaveValue('$2,000');
  });
});
