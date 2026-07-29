import type { Comp } from './App';

export interface CompDotsProps {
  comps: Comp[];
  bounds: { min: number; max: number };
  /** Adopt a comp's number. Caller wires this to setParam + commit. */
  onPick: (amount: number) => void;
  /** Optional: remove a comp. Caller sends the worker message. */
  onRemove?: (comp: Comp) => void;
}

/**
 * A row of clickable dots, one per comp, positioned along the same [min, max] scale as
 * the field they sit under -- the rent slider, or (with no slider to borrow bounds from)
 * a min/max-of-comps range under the ARV field. Pure props in, callbacks out: no chrome.*
 * calls, no storage awareness. App.tsx decides what a pick actually does (setParam +
 * commit, the same path a keystroke takes) and what removal sends to the worker.
 * See docs/comp-workflow.md §4.
 *
 * Rendered as its own track below the slider/field rather than literally overlaid on
 * top of it: a native <input type="range"> captures every pointer event across its full
 * width, so dots drawn on top of one would never receive a click.
 */
export default function CompDots({ comps, bounds, onPick, onRemove }: CompDotsProps) {
  if (comps.length === 0) return null;

  const { min, max } = bounds;
  const percent = (amount: number) =>
    max === min ? 0 : Math.min(100, Math.max(0, ((amount - min) / (max - min)) * 100));
  // High to low, matching CompSummary's list order -- keeps tab order sensible even
  // though dot position is what actually carries the information.
  const sorted = [...comps].sort((a, b) => b.amount - a.amount);

  return (
    <div className="relative h-4 mt-1 mb-3" data-testid="comp-dots">
      {sorted.map((comp) => {
        const perSqft = comp.sqft && Number(comp.sqft) > 0
          ? `$${(comp.amount / Number(comp.sqft)).toFixed(2)}/sqft`
          : null;
        const facts = [comp.beds && `${comp.beds}bd`, comp.baths && `${comp.baths}ba`].filter(Boolean).join('/');
        const amountText = comp.kind === 'rent'
          ? `$${comp.amount.toLocaleString()}/mo`
          : `$${comp.amount.toLocaleString()}${comp.amountLabel === 'last-list' ? ' (list)' : ''}`;
        const tooltip = [comp.address, facts || null, comp.sqft ? `${Number(comp.sqft).toLocaleString()} sqft` : null, amountText, perSqft]
          .filter(Boolean).join(' — ') + (onRemove ? ' (right-click to remove)' : '');

        return (
          <button
            key={`${comp.source}:${comp.propertyID}:${comp.kind}`}
            type="button"
            title={tooltip}
            aria-label={`Use ${comp.address}: ${amountText}`}
            data-testid="comp-dot"
            className="absolute top-0 -translate-x-1/2 w-3 h-3 rounded-full border-2
              border-white dark:border-gray-800 shadow cursor-pointer
              bg-purple-500 hover:bg-purple-600"
            style={{ left: `${percent(comp.amount)}%` }}
            onClick={() => onPick(comp.amount)}
            onContextMenu={(e) => {
              if (!onRemove) return;
              e.preventDefault();
              onRemove(comp);
            }}
          />
        );
      })}
    </div>
  );
}
