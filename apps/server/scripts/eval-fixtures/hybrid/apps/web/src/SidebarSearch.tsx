export function SidebarSearch({ query, items }: { query: string; items: string[] }) {
  // Intentionally case-sensitive for the eval change request.
  return items.filter((item) => item.includes(query));
}
