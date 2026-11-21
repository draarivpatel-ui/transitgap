const neighborhood = (id, name, x, y, pop, dependent, senior, student) =>
  ({ id, name, x, y, pop, dependent, senior, student });
const line = (id, name, color, cycle, run, stops, min = 1, max = 4) =>
  ({ id, name, color, cycle, run, stops, min, max });
const services = (hospital, grocery, school, jobs) =>
  [{ id: 'hospital', at: hospital }, { id: 'grocery', at: grocery },
    { id: 'school', at: school }, { id: 'jobs', at: jobs }];

export const CITIES = [
  {
    id: 'sunbelt', label: 'Sunbelt suburb', subtitle: 'Sprawl during a heat advisory',
    w: 9, h: 6, blockMeters: 570, heat: 40, hours: 12, fleetBudget: 7, shadeBudget: 2,
    baseline: { fleet: [4, 2, 1], shade: [[4, 2], [6, 2]] },
    neighborhoods: [
      neighborhood('westgate', 'Westgate', 0, 2, 2400, 0.19, 0.10, 0.20),
      neighborhood('citrus', 'Citrus Row', 1, 4, 3100, 0.66, 0.18, 0.29),
      neighborhood('palm', 'Palm Terrace', 3, 1, 1750, 0.23, 0.13, 0.18),
      neighborhood('union', 'Union Square', 4, 3, 3600, 0.31, 0.16, 0.21),
      neighborhood('arroyo', 'Arroyo Flats', 5, 5, 4100, 0.72, 0.22, 0.26),
      neighborhood('east', 'East Mesa', 8, 4, 3550, 0.64, 0.29, 0.16),
      neighborhood('ridge', 'Copper Ridge', 8, 0, 2200, 0.25, 0.18, 0.19),
      neighborhood('south', 'South Gardens', 2, 5, 1850, 0.51, 0.18, 0.25)
    ],
    services: services([6, 2], [4, 2], [2, 4], [5, 2]),
    lines: [
      line('B1', 'Central Avenue', '#176b58', 60, [3, 4, 4, 3], [[0, 2], [2, 2], [4, 2], [6, 2], [8, 2]]),
      line('B2', 'Citrus Connector', '#a45029', 60, [4, 4, 3, 4], [[1, 4], [2, 4], [2, 2], [4, 2], [4, 0]]),
      line('B3', 'Mesa Crosstown', '#535f9b', 90, [5, 5, 4, 5], [[2, 5], [5, 5], [6, 4], [6, 2], [8, 4]])
    ]
  },
  {
    id: 'rail', label: 'Rail and feeders', subtitle: 'A midsize city with a fixed rail spine',
    w: 9, h: 7, blockMeters: 490, heat: 36, hours: 13, fleetBudget: 8, shadeBudget: 3,
    baseline: { fleet: [4, 2, 1, 1], shade: [[4, 3], [6, 3], [8, 3]] },
    neighborhoods: [
      neighborhood('foundry', 'Foundry', 0, 3, 3700, 0.48, 0.17, 0.16),
      neighborhood('orchard', 'Orchard', 1, 0, 4300, 0.68, 0.16, 0.24),
      neighborhood('north', 'North Loop', 3, 1, 3400, 0.38, 0.20, 0.18),
      neighborhood('civic', 'Civic Ward', 4, 2, 2900, 0.24, 0.12, 0.20),
      neighborhood('canal', 'Canal Homes', 5, 6, 4800, 0.74, 0.23, 0.25),
      neighborhood('market', 'Market Ward', 7, 4, 3100, 0.42, 0.15, 0.22),
      neighborhood('pine', 'Pine Hill', 8, 0, 2000, 0.37, 0.21, 0.22),
      neighborhood('south', 'South Bank', 8, 6, 3550, 0.72, 0.21, 0.27)
    ],
    services: services([6, 3], [3, 3], [2, 1], [4, 3]),
    lines: [
      line('R', 'Green Line rail', '#176b58', 60, [3, 3, 3, 3], [[0, 3], [2, 3], [4, 3], [6, 3], [8, 3]], 4, 4),
      line('B1', 'Station Express', '#535f9b', 60, [5, 5, 6], [[4, 3], [4, 5], [6, 3], [8, 3]]),
      line('B2', 'North Feeder', '#a45029', 60, [4, 4, 5, 6], [[1, 0], [2, 1], [2, 3], [4, 3], [8, 0]]),
      line('B3', 'South Feeder', '#92386c', 60, [5, 4, 4, 5], [[2, 3], [3, 5], [5, 6], [6, 3], [8, 6]])
    ]
  },
  {
    id: 'rural', label: 'Rural county', subtitle: 'Sparse service under a hard budget cap',
    w: 10, h: 7, blockMeters: 1050, heat: 38, hours: 10, fleetBudget: 5, shadeBudget: 1,
    baseline: { fleet: [3, 1, 1], shade: [[2, 3]] },
    neighborhoods: [
      neighborhood('mill', 'Mill Town', 1, 3, 1550, 0.24, 0.28, 0.17),
      neighborhood('station', 'Station Village', 4, 3, 1400, 0.30, 0.21, 0.20),
      neighborhood('hollow', 'Willow Hollow', 2, 0, 780, 0.71, 0.32, 0.19),
      neighborhood('ridge', 'Pioneer Ridge', 5, 0, 620, 0.69, 0.36, 0.14),
      neighborhood('meadow', 'South Meadow', 5, 6, 930, 0.64, 0.29, 0.22),
      neighborhood('creek', 'Cedar Creek', 7, 5, 570, 0.65, 0.35, 0.16),
      neighborhood('mesa', 'Far Mesa', 9, 0, 320, 0.77, 0.42, 0.11),
      neighborhood('fields', 'East Fields', 9, 6, 490, 0.68, 0.31, 0.18)
    ],
    services: services([0, 3], [2, 3], [4, 3], [6, 3]),
    lines: [
      line('B1', 'County Road', '#176b58', 60, [5, 4, 5], [[0, 3], [2, 3], [4, 3], [6, 3]]),
      line('B2', 'North Branch', '#a45029', 90, [6, 7, 7], [[2, 0], [5, 0], [5, 2], [4, 3]]),
      line('B3', 'South Branch', '#535f9b', 90, [6, 6, 6, 7], [[2, 3], [3, 5], [5, 6], [7, 5], [6, 3]])
    ]
  }
];

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
freeze(CITIES);
export const BASIC = Object.freeze({ heat: true, mode: 'expected', departure: 480 });
