# Sticker and meme spec

## Outcome

Elaina can store sticker packs, retrieve candidates safely, learn candidates from chat, send
real media through OneBot, and provide admin review.

## Current boundary

No runtime sticker/meme implementation exists. The migration importer only creates generic
media rows from a normalized sticker fixture.

## Plugin identity

`sticker-meme` owns storage, selection, and send integration. It declares permissions for
media, storage, channel send, conversation read, tools, UI, and audit. It may not edit other
plugins or read secrets.

## Pack model

```ts
type StickerPack = {
  id: string;
  name: string;
  source: "builtin" | "imported" | "generated" | "learned";
  enabled: boolean;
  tags: string[];
  personaIds: string[];
  metadata: Record<string, unknown>;
};

type StickerItem = {
  id: string;
  packId: string;
  name: string;
  description: string;
  keywords: string[];
  emotions: string[];
  mimeType: string;
  mediaId: string;
  hash: string;
  width?: number;
  height?: number;
  enabled: boolean;
  score: number;
};
```

Plugin-owned migrations (via Phase 3 `MigrationRegistry`, running in `host` mode) create
pack/item tables (`plugin_sticker_meme_*`). The core `media` table remains the canonical binary
registry.

## Import/export

Support:

- local directory pack import
- ZIP/manifest import
- DSH meme pack mapping
- media dedupe by SHA-256
- tag/emotion validation
- disable missing media
- dry-run report

Exports contain manifests and media, but never user content or secrets.

## Selection

Model-facing tools (namespaced under `sticker-meme`):

1. `sticker-meme.search` — text/emotion/persona filtered candidates and metadata.
2. `sticker-meme.choose` — chooses one candidate and returns a transient send token.

Selection uses exact keyword, normalized text, emotion, persona, recent usage, score, enabled
state, and pack preference. No deprecated packs or revoked items are selectable.

Send tokens are single-use, short TTL, conversation-bound, and audited.

## Learned candidates

Learn from:

- imported pack
- explicit admin upload
- inbound sticker marked as learnable
- model-generated reference image under explicit policy

Candidate metadata includes name/description/keywords/emotion/source conversation/media.
Candidates require review before automatic selection. Retention, daily caps, and duplicate
thresholds are configurable.

## Output integration

1. Register a Phase 3 outbound transform hook (`reply.transform`) that scans assistant text for a
   structured sticker directive, not loose markdown.
2. The directive resolves to a validated send token.
3. The token is replaced by a media `MessagePart`.
4. Chunking keeps text/media ordering.
5. OneBot sends a real image segment.
6. Failure downgrades to text plus diagnostic, never injects binary data into text.

Model-visible text never includes absolute local paths or raw URLs.

## Admin UI

- pack list, enable/disable, persona assignment
- item grid with preview, tags, emotions, usage, score
- bulk import/export
- candidate review approve/reject/delete
- usage/anonymized diagnostics
- destructive delete requires backup/confirmation

## Tests

1. Pack/item validation and migrations.
2. Import/export and media dedupe.
3. Selection ranking and policy filtering.
4. Token single-use/TTL/binding.
5. Output transformation, chunking, and failure fallback.
6. Learning/review workflow.
7. DSH meme-pack migration fixture.

## Acceptance

Elaina can import the DSH pack schema shape, select/send a sticker on QQ, review learned
candidates, and prevent unreviewed or unavailable media from being sent.
