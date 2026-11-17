interface Input {
  items: Array<{ id: number; value: number }>;
  factor: number;
}

export function compute({ items, factor }: Input) {
  let total = 0;
  for (let index = 0; index < items.length; index++) {
    total += items[index].value * factor;
  }
  return { total, label: `sum:${total}`, count: items.length };
}
