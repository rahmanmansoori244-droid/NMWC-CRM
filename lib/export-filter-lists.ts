type ExportFilterLists = {
  regionIds?: string[];
  routeIds?: string[];
  statuses?: string[];
  paymentTerms?: string[];
};

// The export UI sends one parameter per selected checkbox. Bound the lists before
// Zod inspects their values or a builder expands them into database predicates.
// Count repetitions too: dropping or truncating a filter could broaden an export.
export function readExportFilterLists(
  params: URLSearchParams,
  includeCustomerFilters = false
): ExportFilterLists | null {
  const filters: ExportFilterLists = {};
  const append = (
    field: keyof ExportFilterLists,
    value: string,
    maxCount: number,
    maxLength: number
  ) => {
    const list = filters[field] ?? (filters[field] = []);
    if (list.length >= maxCount || value.length > maxLength) return false;
    list.push(value);
    return true;
  };

  for (const [key, value] of params) {
    switch (key) {
      case 'regionId':
        if (!append('regionIds', value, 500, 128)) return null;
        break;
      case 'routeId':
        if (!append('routeIds', value, 500, 128)) return null;
        break;
      case 'status':
        if (includeCustomerFilters && !append('statuses', value, 3, 9)) return null;
        break;
      case 'paymentTerms':
        if (includeCustomerFilters && !append('paymentTerms', value, 2, 6)) return null;
        break;
    }
  }
  return filters;
}
