---
name: orval codegen pitfalls
description: Naming collisions and hook-signature shifts when regenerating the API client/zod from OpenAPI.
---

# orval codegen pitfalls

- An operation with both path and query params generates a zod `<Op>Params` schema and a TS type `<Op>Params` that collide on wildcard re-export. **How to apply:** disambiguate with explicit `export {...} from "./generated/api"` lines in `lib/api-zod/src/index.ts` (zod value wins; alias the TS type, e.g. `List...QueryParamsType`). Pattern already in place.
- Adding query params to an operation shifts its generated hook signature to `(params, options)` — existing call sites passing `{ query }` as the first arg must become `(undefined, { query })`.
- Never name a component schema `<OperationId>Body` or `<OperationId>Response` — orval emits both names itself; the api-zod schemas to import in routes are the operation-derived names, not component names.
- Generated `use<Op>` hooks default their query key at runtime (`queryOptions?.queryKey ?? get<Op>QueryKey(params)`), but the TS type requires `queryKey` when overriding `queryFn` — pass `get<Op>QueryKey()` explicitly (and ensure test mocks of `@workspace/api-client-react` export it, or mocked pages crash at render).
