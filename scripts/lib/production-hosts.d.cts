// Types for scripts/lib/production-hosts.cjs (code review 2026-11-10, finding 14).
export declare const PRODUCTION_HOSTS_FILE: string;
export declare const MARKER_SHAPE: RegExp;
export declare class ProductionHostsError extends Error {
  constructor(reason: string);
}
export declare function parseProductionHosts(text: unknown): string[];
export declare function loadProductionHosts(file?: string): string[];
export declare function checkedHosts(hosts: readonly string[]): readonly string[];
export declare function hostMarker(hostname: string | null | undefined, hosts: readonly string[]): string | null;
export declare function productionMarkerIn(value: string | null | undefined, hosts: readonly string[]): string | null;
export declare function namesProduction(expectHost: string | null | undefined, hosts: readonly string[]): boolean;
