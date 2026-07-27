import { ComposedChart, XAxis, YAxis, Tooltip, ReferenceLine, ReferenceArea, ResponsiveContainer } from 'recharts';

/**
 * The rent distribution chart, in its own module so it can be code-split.
 *
 * recharts is ~550 kB and was in the panel's main bundle, parsed before the panel could
 * paint even though this chart only appears when a rent dropdown is open *and* an estimate
 * exists -- which, with no model service running, is never. App.tsx loads it with
 * React.lazy so that cost is paid only when a chart is actually drawn.
 */

export interface RentChartValues {
  min: number;
  max: number;
  mid: number;
  iqrlow: number;
  iqrhigh: number;
  /** Break-even rent, clamped into the chart's bounds. Null when it can't be computed. */
  profitability: number | null;
}

export default function RentChart({ chartBounds, clampedValues, chartTicks, sliderValue }: {
  chartBounds: { min: number; max: number };
  clampedValues: RentChartValues;
  chartTicks: number[];
  /** The rent the user has entered, drawn as its own line. */
  sliderValue: number;
}) {
  return (
    <div className="w-full">
              {/*
                debounce matters here: ResponsiveContainer re-measures and re-renders the
                whole chart on every resize tick, and dragging the side panel divider
                produces a continuous stream of them. Without it, each open rent
                dropdown re-renders a recharts tree dozens of times per drag, which is
                what made widening the panel feel sluggish on both sites.
              */}
              <ResponsiveContainer width="100%" height={120} debounce={200}>
                <ComposedChart
                  data={[{ value: clampedValues.mid }]}
                  margin={{ top: 30, right: 30, left: 30, bottom: 30 }}
                >
                  {/*
                    TODO(rent-model): a custom tick renderer here labelled two ticks
                    "min observed" / "max observed" and drew every other tick as an empty
                    string, so the axis carried those two words and nothing else. Both
                    described data we don't have yet. Dollar ticks until we do.
                  */}
                  <XAxis
                    dataKey="value"
                    type="number"
                    domain={[chartBounds.min, chartBounds.max]}
                    allowDataOverflow
                    tickFormatter={(value) => `$${value.toLocaleString()}`}
                    ticks={chartTicks}
                    height={40}
                    tick={{ fontSize: 11, fill: '#6B7280' }}
                  />
                  <YAxis hide />
                  <Tooltip 
                    formatter={(value) => `$${Number(value).toLocaleString()}`}
                    labelFormatter={() => 'Rent Range'}
                  />
                  
                  {/* Background reference area */}
                  <ReferenceArea
                    x1={chartBounds.min}
                    x2={chartBounds.max}
                    fill="#E5E7EB"
                    fillOpacity={0.3}
                  />
                  
                  {/* IQR Box */}
                  <ReferenceArea
                    x1={clampedValues.iqrlow}
                    x2={clampedValues.iqrhigh}
                    fill="#f87171"
                    fillOpacity={0.3}
                  />

                  {/* Always show observed min and max markers */}
                  <ReferenceLine
                    x={clampedValues.min}
                    stroke="#6B7280"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  <ReferenceLine
                    x={clampedValues.max}
                    stroke="#6B7280"
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  
                  {/* Predicted min line (IQR low) */}
                  <ReferenceLine
                    x={clampedValues.iqrlow}
                    stroke="#ef4444"
                    strokeWidth={2}
                  />
                  
                  {/* Predicted max line (IQR high) */}
                  <ReferenceLine
                    x={clampedValues.iqrhigh}
                    stroke="#ef4444"
                    strokeWidth={2}
                  />
                  
                  {/* Predicted median line */}
                  <ReferenceLine
                    x={clampedValues.mid}
                    stroke="#ef4444"
                    strokeWidth={5}
                  />
                  
                  {/* Selected value line */}
                  {Number(sliderValue) > 0 && (
                    <ReferenceLine
                      x={Number(sliderValue)}
                      stroke="#3b82f6"
                      strokeWidth={2}
                    />
                  )}

                  {/* Break-even rent line */}
                  {clampedValues.profitability !== null && clampedValues.profitability > 0 && (
                    <ReferenceLine
                      x={clampedValues.profitability}
                      stroke="#10b981"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      label={{
                        value: 'break-even',
                        position: 'top',
                        fontSize: 12,
                        fill: '#10b981',
                        offset: 4
                      }}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
    </div>
  );
}
