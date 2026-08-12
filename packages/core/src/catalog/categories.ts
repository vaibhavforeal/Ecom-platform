/**
 * Category trees.
 *
 * Stored as adjacency (`parent_id`) rather than as a materialised path,
 * because the merchandising operation merchants actually perform is
 * "move this branch somewhere else", which is one UPDATE here and a
 * subtree rewrite with a path. Trees are small — a few hundred nodes at
 * the top end — so the cost of assembling one in memory is nothing.
 *
 * The functions below are pure and take the full node list, so they are
 * testable without a database and reusable for breadcrumbs, navigation
 * and the JSON-LD `BreadcrumbList` alike.
 */

export type CategoryNode = {
  id: string;
  parentId: string | null;
  title: string;
  position: number;
};

export type CategoryTreeNode<T extends CategoryNode = CategoryNode> = T & {
  children: CategoryTreeNode<T>[];
  depth: number;
};

/**
 * Guard against a malformed tree looping forever.
 *
 * A cycle should be impossible — `isDescendant` below is what stops one
 * being created — but "should be impossible" is not a reason for a
 * render path to hang. Depth is capped instead.
 */
const MAX_DEPTH = 32;

/** Root-to-node path, used for breadcrumbs. Empty if the id is unknown. */
export function categoryPath<T extends CategoryNode>(nodes: T[], id: string): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: T[] = [];

  let current = byId.get(id);
  for (let i = 0; current && i < MAX_DEPTH; i++) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return path;
}

/** Assembles the adjacency list into a tree, sorted by position then title. */
export function buildCategoryTree<T extends CategoryNode>(nodes: T[]): CategoryTreeNode<T>[] {
  const byId = new Map<string, CategoryTreeNode<T>>(
    nodes.map((n) => [n.id, { ...n, children: [], depth: 0 }]),
  );

  const roots: CategoryTreeNode<T>[] = [];

  for (const node of byId.values()) {
    // A node whose parent is missing (deleted, or filtered out because it
    // is hidden) becomes a root rather than vanishing. Dropping it would
    // silently remove its whole subtree from the navigation.
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (list: CategoryTreeNode<T>[], depth: number): void => {
    list.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    for (const child of list) {
      child.depth = depth;
      if (depth < MAX_DEPTH) sort(child.children, depth + 1);
    }
  };
  sort(roots, 0);

  return roots;
}

/**
 * Is `candidateId` inside `rootId`'s subtree?
 *
 * The check that stops a merchant reparenting a category under its own
 * child. The database CHECK constraint only catches the one-step case
 * (a category as its own parent); a two-step cycle would detach the
 * whole branch from every root, at which point it is invisible in the
 * console and unfixable through the UI.
 */
export function isDescendant(
  nodes: CategoryNode[],
  rootId: string,
  candidateId: string,
): boolean {
  if (rootId === candidateId) return true;

  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const siblings = childrenOf.get(n.parentId) ?? [];
    siblings.push(n.id);
    childrenOf.set(n.parentId, siblings);
  }

  const stack = [rootId];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (id === candidateId) return true;
    stack.push(...(childrenOf.get(id) ?? []));
  }

  return false;
}

/**
 * Every category id in a subtree, including the root.
 *
 * A category listing shows products from descendants too — a shopper
 * browsing "Apparel" expects to see what is filed under "Apparel >
 * Shirts", not an empty page because everything is filed one level down.
 */
export function subtreeIds(nodes: CategoryNode[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const siblings = childrenOf.get(n.parentId) ?? [];
    siblings.push(n.id);
    childrenOf.set(n.parentId, siblings);
  }

  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }

  return out;
}
