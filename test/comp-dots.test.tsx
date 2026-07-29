import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CompDots from '../src/CompDots';
import type { Comp } from '../src/App';

const comp = (over: Partial<Comp> = {}): Comp => ({
  source: 'redfin', propertyID: '555', kind: 'rent', address: '456 Comp Ave, Austin, TX 78745',
  amount: 2100, amountLabel: 'rent', beds: '3', baths: '2', sqft: '1400',
  url: 'https://www.redfin.com/x/455/home/555', soldDate: null, capturedAt: 1_000,
  ...over
});

describe('CompDots', () => {
  it('renders nothing for an empty comp list', () => {
    const { container } = render(
      <CompDots comps={[]} bounds={{ min: 0, max: 4000 }} onPick={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one dot per comp', () => {
    const comps = [comp({ propertyID: '1' }), comp({ propertyID: '2' }), comp({ propertyID: '3' })];
    render(<CompDots comps={comps} bounds={{ min: 0, max: 4000 }} onPick={() => {}} />);
    expect(screen.getAllByTestId('comp-dot')).toHaveLength(3);
  });

  it('clicking a dot fires onPick with that comp\'s amount', () => {
    const onPick = vi.fn();
    render(<CompDots comps={[comp({ amount: 2350 })]} bounds={{ min: 0, max: 4000 }} onPick={onPick} />);

    fireEvent.click(screen.getByTestId('comp-dot'));
    expect(onPick).toHaveBeenCalledWith(2350);
  });

  it('positions a dot proportionally between the bounds', () => {
    render(<CompDots comps={[comp({ amount: 2000 })]} bounds={{ min: 1000, max: 3000 }} onPick={() => {}} />);
    // (2000 - 1000) / (3000 - 1000) = 50%
    expect(screen.getByTestId('comp-dot')).toHaveStyle({ left: '50%' });
  });

  it('clamps a dot within the track when its amount falls outside the bounds', () => {
    render(<CompDots comps={[comp({ amount: 9000 })]} bounds={{ min: 0, max: 4000 }} onPick={() => {}} />);
    expect(screen.getByTestId('comp-dot')).toHaveStyle({ left: '100%' });
  });

  it('does not fire onPick on a right-click, and calls onRemove instead when provided', () => {
    const onPick = vi.fn();
    const onRemove = vi.fn();
    const target = comp();
    render(<CompDots comps={[target]} bounds={{ min: 0, max: 4000 }} onPick={onPick} onRemove={onRemove} />);

    fireEvent.contextMenu(screen.getByTestId('comp-dot'));
    expect(onRemove).toHaveBeenCalledWith(target);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('does nothing on right-click when no onRemove is given', () => {
    expect(() => {
      render(<CompDots comps={[comp()]} bounds={{ min: 0, max: 4000 }} onPick={() => {}} />);
      fireEvent.contextMenu(screen.getByTestId('comp-dot'));
    }).not.toThrow();
  });
});
