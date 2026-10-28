import type { Category } from "./types";

export function sortGroups(all: Category[]): Category[] {
  return all.filter((c) => !c.selectable).sort((a, b) =>
    (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER) ||
    b.year - a.year || a.order - b.order,
  );
}
