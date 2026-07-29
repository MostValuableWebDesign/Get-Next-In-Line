export * from "./generated/api";
export * from "./generated/types";

// orval emits both a zod path-params schema (generated/api) and a TS
// query-params type (generated/types) named `<Op>Params` when an operation
// has path AND query params — disambiguate explicitly: the zod schema wins
// the value slot, the query-params shape stays available under an aliased
// type name.
export { ListEngagementRulesParams, ListClientProfilesParams } from "./generated/api";
export type { ListEngagementRulesParams as ListEngagementRulesQueryParamsType } from "./generated/types";
export type { ListClientProfilesParams as ListClientProfilesQueryParamsType } from "./generated/types";
export * from './generated/api';
export * from './generated/types';
