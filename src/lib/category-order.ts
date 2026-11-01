import type { Category } from "./types";

export function sortGroups(all: Category[]): Category[] {
  return all.filter((c) => !c.selectable).sort((a, b) =>
    (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER) ||
    b.year - a.year || a.order - b.order,
  );
}

// Collapse only matching names across years in assignment/editing menus.
// Keep original IDs and same-year duplicates for historical records.
export function currentCategoryChoices(all: Category[]) {
  const key = (name: string) => name.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
  const parents = all.filter((c) => !c.selectable);
  const byId = new Map(parents.map((c) => [c.id, c]));
  const newestGroupYear = new Map<string, number>();
  for (const parent of parents)
    newestGroupYear.set(key(parent.name), Math.max(newestGroupYear.get(key(parent.name)) || 0, parent.year));
  const groups = sortGroups(all).filter((g) => g.year === newestGroupYear.get(key(g.name)));
  const preferredGroup = new Map<string, Category>();
  for (const group of groups)
    if (!preferredGroup.has(key(group.name))) preferredGroup.set(key(group.name), group);
  const newestItemYear = new Map<string, number>();
  const itemKey = (item: Category) => {
    const parent = byId.get(item.parent_id || "");
    return parent ? `${key(parent.name)}|${key(item.name)}` : item.id;
  };
  for (const item of all.filter((c) => c.selectable))
    newestItemYear.set(itemKey(item), Math.max(newestItemYear.get(itemKey(item)) || 0, item.year));
  const children = new Map(groups.map((group) => [group.id, [] as Category[]]));
  for (const item of all.filter((c) => c.selectable && c.year === newestItemYear.get(itemKey(c)))) {
    const parent = byId.get(item.parent_id || "");
    if (!parent) continue;
    const displayGroup = children.has(parent.id) ? parent : preferredGroup.get(key(parent.name));
    if (displayGroup) children.get(displayGroup.id)!.push(item);
  }
  for (const items of children.values()) items.sort((a, b) => b.year - a.year || a.order - b.order);
  const canonicalByKey = new Map<string, string>();
  const displayGroupByItemId = new Map<string, string>();
  for (const [groupId, items] of children)
    for (const item of items) {
      if (!canonicalByKey.has(itemKey(item))) canonicalByKey.set(itemKey(item), item.id);
      displayGroupByItemId.set(item.id, groupId);
    }
  const canonicalIdById = new Map<string, string>();
  const displayedIds = new Set([...children.values()].flat().map((c) => c.id));
  for (const item of all.filter((c) => c.selectable))
    canonicalIdById.set(item.id, displayedIds.has(item.id) ? item.id : canonicalByKey.get(itemKey(item)) || item.id);
  return { groups, children, canonicalIdById, displayGroupByItemId };
}
