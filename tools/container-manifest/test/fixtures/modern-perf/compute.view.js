export function compute({ items, factor }) {
  let total = 0;
  for (let index = 0; index < items.length; index++) {
    total += items[index].value * factor;
  }
  return { total, label: `sum:${total}`, count: items.length };
}
