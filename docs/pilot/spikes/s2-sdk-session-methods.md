# S2 — opencode SDK session methods

**Question:** Confirm shape of `client.session.create({ workspaceID })`, `client.session.promptAsync(...)`, `client.session.abort(...)`, `client.session.info(...)`.

**Verdict:** Methods exist, but call shapes diverge from the plan's pseudocode. Two corrections required.

## Evidence (from `@opencode-ai/sdk@1.14.19`)

Source: `node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts` and `types.gen.d.ts`.

### `session.create`

```ts
type SessionCreateData = {
  body?: { parentID?: string; title?: string };
  query?: { directory?: string };
  url: "/session";
};
// Returns: Session
```

**There is no `workspaceID` field.** Working directory is `query.directory` (NOT body). Plan pseudocode `client.session.create({ workspaceID: wt.path })` will not typecheck.

Correct usage:
```ts
const { data: session } = await client.session.create({
  body: { title: `pilot/${task.id}` },
  query: { directory: wt.path },
});
```

### `session.promptAsync`

```ts
type SessionPromptAsyncData = {
  body?: {
    messageID?: string;
    model?: { providerID: string; modelID: string };
    agent?: string;
    noReply?: boolean;
    system?: string;
    tools?: { [key: string]: boolean };
    parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;
  };
  path: { id: string };
  query?: { directory?: string };
  url: "/session/{id}/prompt_async";
};
// Returns: 204 No Content (no message body)
```

Notes:
- `body.parts` is **required** even though it's marked optional via `body?`. Empty body = empty prompt.
- `agent` is per-prompt selectable. The pilot worker will pass `agent: "pilot-builder"` here.
- `directory` query may also be needed for routing — pass it for safety.

Correct usage:
```ts
await client.session.promptAsync({
  path: { id: session.id },
  query: { directory: wt.path },
  body: {
    agent: "pilot-builder",
    parts: [{ type: "text", text: kickoffPrompt(task, runContext) }],
  },
});
```

### `session.abort`

```ts
type SessionAbortData = {
  path: { id: string };
  query?: { directory?: string };
  url: "/session/{id}/abort";
};
// Returns: boolean
```

Correct usage:
```ts
await client.session.abort({ path: { id: session.id }, query: { directory: wt.path } });
```

### `session.info` — DOES NOT EXIST

The plan references `client.session.info`. Available alternatives:

- `client.session.get({ path: { id }, query: { directory } })` → returns full `Session` object.
- `client.session.status({ query: { directory } })` → returns map of `{ [sessionID]: SessionStatus }`.

For cost polling: use `session.get` to fetch the `Session` shape, then either read cost fields (verify they exist on `Session` at implementation time — TBD) or aggregate via `session.messages({ path: { id } })` and sum per-message cost.

## Action items for Phase D

- `src/pilot/opencode/session.ts` should wrap these calls with the corrected shapes.
- Phase D test fixtures must use the `path`/`query`/`body` envelope, not flat args.
- Worker's cost-update logic (E1) needs an extra step to discover where cost lives in `Session` — open question, defer to E1 implementation.
