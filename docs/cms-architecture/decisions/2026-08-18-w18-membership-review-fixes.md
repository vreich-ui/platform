# 2026-08-18 — W18 membership review: the paginated-list defect, and the Identities tab

**Status: RULED (Wolf, 2026-08-18).** Wolf ran the W18 acceptance pass
(`docs/cms-architecture/W18-acceptance.md`) against a live site and reported five
symptoms. Four of them turned out to be one defect. This record fixes what the
defect was, why no test saw it, and the two things Wolf ruled on.

## The defect: `store.list({ paginate: true })` is not a Promise

`@netlify/blobs@10` (`dist/main.d.ts`) types `list()` with two overloads:

```ts
list(options: ListOptions & { paginate: true }):   AsyncIterable<ListResult>;   // NOT a Promise
list(options?: ListOptions & { paginate?: false }): Promise<ListResult>;
```

Every W18 membership helper asked for `paginate: true` and then read `.blobs`
off the awaited value:

```ts
const listed = await store.list({ prefix, directories: false, paginate: true });
for (const blob of listed.blobs ?? []) { … }   // never iterates in production
```

`await <AsyncIterable>` yields the iterable itself, so `.blobs` is `undefined`,
`?? []` swallows it, and **every membership listing silently saw an empty
store**. Chaining `.then()` / `.catch()` off it is worse — it throws
_synchronously_, which is how `membership-sweep` failed on every scheduled run.

This is the same class of bug as the **2026-08-06 hotfix**, which introduced
`collectBlobListItems` in `packages/core/server/lib/blob-list.ts` and migrated
every consumer of the day. W18 was written after that fix but against the old
pattern, and nothing caught the divergence:

- `MembershipStore.list` was _declared_ as `Promise<{ blobs }>` and
  `getMembershipStore` reached the real client through
  `as unknown as Promise<MembershipStore>`, so TypeScript had nothing to
  disagree with.
- Every membership test mock returned `{ blobs }` as a Promise and ignored
  `paginate`, so all 2 491 tests — including the T18.9 E2E harness — passed.

### What was actually broken in production

| Call site                                                         | Effect                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `read.ts` `listMembers`                                           | members list empty — only `ADMIN_EMAILS` rows rendered                      |
| `invitations.ts` `listInvitations`                                | Invitations tab always empty                                                |
| `invitations.ts` `previewInvitationByToken`                       | shareable invite link never previewed                                       |
| `invitations.ts` `expireAll`                                      | invitations never expired                                                   |
| `invitations.ts` `listUnmanagedIdentities` (via `listMembers`)    | **every real member listed as "unmanaged", with _Delete identity_ offered** |
| `write.ts` `listAuditForEmail`                                    | audit drawer always empty                                                   |
| `read.ts` `countActiveOwners` / `write.ts` `wouldBreachMinOwners` | stored owners counted as 0 — the `min_owners` guard degraded                |
| `offboarding.ts` `revokeOAuthGrantsForSubject`                    | OAuth grants NOT revoked on suspend/remove                                  |
| `offboarding.ts` `releaseLocksHeldBy`                             | object locks never handed off                                               |
| `offboarding.ts` `drainIdentityDeleteQueue`                       | queue never drained                                                         |
| `offboarding.ts` `exportPerson`                                   | authored history missing from the person export                             |
| `functions/membership-sweep.ts`                                   | threw synchronously on every scheduled run                                  |
| `agent/chat-store.ts`, `agent/preferences.ts`                     | same pattern, same silent-empty result (outside W18, fixed here)            |

## The law

**Any `paginate: true` blob listing MUST be consumed through
`collectBlobListItems`.** Three things now enforce it:

1. `MembershipStore.list`, `OAuthBlobStore.list`, `ObjectLockSweepStore.list`,
   `AgentChatStore.list` and `LearningEvidenceStore.list` are typed
   `BlobListResponse | Promise<BlobListResponse>` — the AsyncIterable shape is
   representable, so `.blobs` no longer type-checks.
2. `tests/netlify/membership-paginated-list.test.ts` carries the only store mock
   in the suite that honours `paginate: true` the way the real client does
   (multi-page, async-iterable, no `.then`). It fails on the pre-fix code.
3. The same file's source guard walks `packages/core/server` and fails if any
   file mentions `paginate: true` without `collectBlobListItems`.

## Wolf's two rulings

**R-1 — the Identities tab is HIDDEN.** Every member arrives through the
platform invite flow, so a "GoTrue users with no membership here" reconcile view
is noise; while the defect above was live it was also dangerous. `IdentitiesPanel`
and the `unmanaged_identities` / `grant` / `delete_identity` verbs are KEPT —
`SHOW_IDENTITIES_TAB` in `packages/core/admin/AdminUsers.tsx` brings the tab back
in one line if Netlify-UI-invited users become a real path again.

**R-2 — fix the two UI defects found alongside.**

- _"Show removed" was unreachable._ The toggle rendered only when
  `removedCount > 0`, but `removed` rows are filtered out server-side unless
  `include_removed` is set — which only the toggle sets. Owners now always get it.
- _The row menu shifted the table._ `DataTable`'s root is `overflow-x-auto`;
  per CSS, `overflow-x: auto` forces computed `overflow-y: visible → auto`, so the
  `absolute` dropdown counted as scrollable overflow and grew the container.
  `DropdownMenu` now portals its panel to `<body>` and positions it `fixed` from
  the trigger's rect, flipping above when there is more room and closing on
  scroll/resize. Native `<dialog>` modals are in the real top layer and still sit
  above it. The ARIA/keyboard contract is unchanged.

## Still open (NOT ruled)

Two review findings were left for Wolf and are not addressed here:

- **Deleting a user in Netlify cannot remove their row** when it is synthesized
  from `ADMIN_EMAILS` / `ROLE_EMAILS_*`. Correct behaviour, but the only hint is
  a badge tooltip; it needs explicit copy.
- **A fresh site's Owners are all env rows**, so the whole lifecycle surface
  (`change_role` / `suspend` / `remove`) is unreachable until someone is promoted
  to a stored Owner. It likely wants a first-run banner.
