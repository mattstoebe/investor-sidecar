import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HouseCard, DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import type { House, GlobalParameters } from '../src/App';

/**
 * Switching a single card's strategy, and what the tiles say before it has the inputs to say
 * anything. The comparison the tiles offer -- "mediocre rental, good flip" without committing
 * to either -- is the payoff of modes over a mode switch.
 */

const globalParams: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1.2 };

const house = (overrides: Partial<House> = {}): House => ({
  address: '123 Example St',
  price: '$400,000',
  beds: '3', baths: '2', sqft: '1800',
  propertyID: '12345',
  url: 'https://www.redfin.com/home/12345',
  latitude: 32.7, longitude: -97.3,
  localParams: { sliderValue: 2800 },
  ...overrides
});

const ready = () => {
  vi.mocked(chrome.runtime.sendMessage).mockClear();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true, saved: true });
};

const sentModeUpdates = () =>
  vi.mocked(chrome.runtime.sendMessage).mock.calls
    .map(([msg]) => msg as { action?: string; writer?: string; localParams?: { mode?: string | null } })
    .filter((msg) => msg?.action === 'updateLocalParams' && msg.localParams && 'mode' in msg.localParams);

describe('the mode chip', () => {
  it('shows the strategy the card is being evaluated under', () => {
    ready();
    render(<HouseCard house={house()} globalParams={globalParams} />);
    expect(screen.getByTestId('mode-chip')).toHaveTextContent('Buy and hold');
  });

  it('shows a per-house choice over the panel default', () => {
    ready();
    render(
      <HouseCard
        house={house({ localParams: { sliderValue: 2800, mode: 'flip' } })}
        globalParams={globalParams}
      />
    );
    expect(screen.getByTestId('mode-chip')).toHaveTextContent('Fix and flip');
  });

  it('keeps the tiles closed until asked, so a card costs one line', () => {
    ready();
    render(<HouseCard house={house()} globalParams={globalParams} />);
    expect(screen.queryByTestId('mode-tile-flip')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mode-chip'));
    expect(screen.getByTestId('mode-tile-flip')).toBeInTheDocument();
  });
});

describe('the tiles', () => {
  it('previews what each strategy says about this house', () => {
    ready();
    render(
      <HouseCard
        house={house({ localParams: { sliderValue: 2800, arv: 520000, rehabBudget: 45000 } })}
        globalParams={globalParams}
      />
    );
    fireEvent.click(screen.getByTestId('mode-chip'));

    // Rental leads with cash flow, flip with the max allowable offer. Both are real figures,
    // computed without committing to either strategy.
    expect(screen.getByTestId('mode-tile-rental')).toHaveTextContent('$');
    expect(screen.getByTestId('mode-tile-flip')).toHaveTextContent('$');
  });

  /**
   * On a freshly captured board there is no ARV and no honest way to guess one, so the flip
   * tile asks for it. Fabricating a value to avoid the blank would put a confident profit on
   * screen that nobody entered.
   */
  it('asks for the missing input rather than inventing one', () => {
    ready();
    render(<HouseCard house={house()} globalParams={globalParams} />);
    fireEvent.click(screen.getByTestId('mode-chip'));

    expect(screen.getByTestId('mode-tile-flip')).toHaveTextContent('needs ARV');
    // And nothing that looks like a computed profit.
    expect(screen.getByTestId('mode-tile-flip')).not.toHaveTextContent('$');
  });

  it('asks for rent when that is what is missing', () => {
    ready();
    render(
      <HouseCard
        house={house({ localParams: { sliderValue: 0, arv: 520000 } })}
        globalParams={globalParams}
      />
    );
    fireEvent.click(screen.getByTestId('mode-chip'));
    expect(screen.getByTestId('mode-tile-rental')).toHaveTextContent('needs rent');
  });
});

describe('switching strategy', () => {
  it('records the choice against this house alone', async () => {
    ready();
    render(<HouseCard house={house()} globalParams={globalParams} />);
    fireEvent.click(screen.getByTestId('mode-chip'));
    fireEvent.click(screen.getByTestId('mode-tile-flip'));

    await waitFor(() => expect(sentModeUpdates()).toHaveLength(1));
    expect(sentModeUpdates()[0].localParams?.mode).toBe('flip');
  });

  /**
   * Attributed to something other than this card, so the card re-reads rather than skipping
   * the write as its own echo -- a switch changes which fields exist, and holding state from
   * the strategy just left is how stale inputs survive into a new one.
   */
  it('is written as a foreign change so the card re-reads', async () => {
    ready();
    render(<HouseCard house={house()} globalParams={globalParams} />);
    fireEvent.click(screen.getByTestId('mode-chip'));
    fireEvent.click(screen.getByTestId('mode-tile-flip'));

    await waitFor(() => expect(sentModeUpdates()).toHaveLength(1));
    expect(sentModeUpdates()[0].writer).toBe('mode-picker');
  });

  it('offers to take the switch back', async () => {
    ready();
    const onModeChanged = vi.fn();
    render(<HouseCard house={house()} globalParams={globalParams} onModeChanged={onModeChanged} />);
    fireEvent.click(screen.getByTestId('mode-chip'));
    fireEvent.click(screen.getByTestId('mode-tile-flip'));

    await waitFor(() => expect(onModeChanged).toHaveBeenCalledWith('Fix and flip'));
  });

  it('can be handed back to the panel default', async () => {
    ready();
    render(
      <HouseCard
        house={house({ localParams: { sliderValue: 2800, mode: 'flip' } })}
        globalParams={globalParams}
      />
    );
    fireEvent.click(screen.getByTestId('mode-chip'));
    fireEvent.click(screen.getByTestId('mode-reset'));

    await waitFor(() => expect(sentModeUpdates()).toHaveLength(1));
    expect(sentModeUpdates()[0].localParams?.mode).toBeNull();
  });

  /** Nothing to reset when the card is already inheriting. */
  it('does not offer a reset on an inherited strategy', () => {
    ready();
    render(<HouseCard house={house()} globalParams={globalParams} />);
    fireEvent.click(screen.getByTestId('mode-chip'));
    expect(screen.queryByTestId('mode-reset')).not.toBeInTheDocument();
  });
});

/** A card in flip mode is a different card: different rows, different chips, no rent. */
describe('a card showing a flip', () => {
  const flipHouse = () => house({
    localParams: { sliderValue: 0, mode: 'flip', arv: 520000, rehabBudget: 45000 }
  });

  it('shows the flip metrics, not the rental ones', () => {
    ready();
    render(<HouseCard house={flipHouse()} globalParams={globalParams} />);
    expect(screen.getByTestId('mao')).toBeInTheDocument();
    expect(screen.getByTestId('net-profit')).toBeInTheDocument();
    expect(screen.queryByTestId('monthly-cash-flow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dscr')).not.toBeInTheDocument();
  });

  it('shows the sections a flip has, and not the ones it does not', () => {
    ready();
    render(<HouseCard house={flipHouse()} globalParams={globalParams} />);
    expect(screen.getByTestId('toggle-rehab')).toBeInTheDocument();
    expect(screen.getByTestId('toggle-resale')).toBeInTheDocument();
    // No rent row: a flip has no tenant.
    expect(screen.queryByTestId('rent-field')).not.toBeInTheDocument();
    expect(screen.queryByTestId('toggle-expenses')).not.toBeInTheDocument();
  });

  it('renders its own inputs from the registry', () => {
    ready();
    render(<HouseCard house={flipHouse()} globalParams={globalParams} />);
    fireEvent.click(screen.getByTestId('toggle-resale'));

    expect(screen.getByTestId('param-arv')).toBeInTheDocument();
    expect(screen.getByTestId('rate-field-Selling costs')).toBeInTheDocument();
    expect(screen.getByTestId('rate-field-Max offer rule')).toBeInTheDocument();
  });

  it('prompts for the after-repair value instead of erroring without one', () => {
    ready();
    render(
      <HouseCard
        house={house({ localParams: { sliderValue: 0, mode: 'flip' } })}
        globalParams={globalParams}
      />
    );
    expect(screen.getByTestId('needs-rent-hint')).toHaveTextContent('after-repair value');
    expect(screen.queryByTestId('analysis-error')).not.toBeInTheDocument();
  });
});

/**
 * A stabilized BRRRR *is* a rental -- the same income and the same running costs, measured
 * against the after-repair value and serviced by a different loan. It gets the same expense
 * breakdown rather than a bare list of rate fields, which is what it had when the waterfall
 * was rental-only.
 */
describe('a card showing a BRRRR', () => {
  const brrrrHouse = () => house({
    localParams: {
      sliderValue: 3200, mode: 'brrrr', arv: 520000, rehabBudget: 45000
    }
  });

  const openOperating = () => {
    render(<HouseCard house={brrrrHouse()} globalParams={globalParams} />);
    fireEvent.click(screen.getByTestId('toggle-operating'));
  };

  it('breaks the expenses down instead of only listing rates', () => {
    ready();
    openOperating();

    // getAllByText because several of these appear twice by design: once as the computed
    // line, once as the label of the rate field that drives it. That pairing is the point.
    for (const label of ['Gross Rent', 'Property Tax', 'Insurance', 'Maintenance', 'Management']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Net operating income')).toBeInTheDocument();
  });

  it('still offers the rate fields alongside the figures they drive', () => {
    ready();
    openOperating();
    expect(screen.getByTestId('rate-field-Vacancy')).toBeInTheDocument();
    expect(screen.getByTestId('rate-field-Management')).toBeInTheDocument();
  });

  /** Below NOI is where the strategies part company. */
  it('services the loan that replaced the purchase mortgage', () => {
    ready();
    openOperating();
    expect(screen.getByText('Refinanced loan payment')).toBeInTheDocument();
    expect(screen.queryByText('Mortgage P&I')).not.toBeInTheDocument();
  });

  it('leads with cash flow after the refinance, and what is still tied up', () => {
    ready();
    openOperating();
    expect(screen.getByText('Cash flow after refinance')).toBeInTheDocument();
    expect(screen.getByText('Return on cash left in')).toBeInTheDocument();
    expect(screen.getByText('Cash left in the deal')).toBeInTheDocument();
  });

  it('totals its monthly cost on the collapsed row', () => {
    ready();
    render(<HouseCard house={brrrrHouse()} globalParams={globalParams} />);
    const row = screen.getByTestId('toggle-operating').closest('div')!;
    expect(row.textContent).toMatch(/\$[\d,]+/);
  });

  /** A flip has no tenant, so it has no operating section at all -- not an empty one. */
  it('is not offered for a flip, which has nobody living in it', () => {
    ready();
    render(
      <HouseCard
        house={house({ localParams: { sliderValue: 0, mode: 'flip', arv: 520000 } })}
        globalParams={globalParams}
      />
    );
    expect(screen.queryByTestId('toggle-operating')).not.toBeInTheDocument();
  });
});
