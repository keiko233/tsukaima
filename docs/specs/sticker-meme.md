# Sticker and meme spec

## Outcome

Tsukaima imports Telegram sticker sets directly, enriches every sticker with a semantic profile,
retrieves candidates safely, learns candidates from chat, sends real media through OneBot, and
provides admin review.

## Plugin identity

`sticker-meme` owns storage, selection, and send integration. It declares permissions for
media, storage, channel send, conversation read, tools, UI, and audit. It may not edit other
plugins or read secrets belonging to other plugins; its own Telegram and semantic-model
credentials stay in secret config.

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
  semantic: {
    source: "none" | "heuristic" | "vision" | "merged" | "manual";
    labels: string[];
    emotions: string[];
    intents: string[];
    tones: string[];
    keywords: string[];
    description: string;
  };
  score: number;
};
```

Plugin-owned migrations (via Phase 3 `MigrationRegistry`, running in `host` mode) create
pack/item tables (`plugin_sticker_meme_*`). The core `media` table remains the canonical binary
registry.

## Telegram import

The primary import path is a Telegram sticker-set reference:

- `https://t.me/addstickers/<name>`
- `tg://addstickers?set=<name>`
- a bare set name or `addstickers/<name>` shorthand

The plugin uses the Bot API `getStickerSet`/`getFile` calls through grammY and a bot token
configured in the plugin panel, the backend plugin settings form, or
`TSUKAIMA_TELEGRAM_BOT_TOKEN`. Secret fields are write-only in the API. Re-importing the same set
reuses a stable pack id and item ids, dedupes media by SHA-256, and updates metadata in place.
Static stickers are stored as WebP/PNG.

Animated TGS stickers are decoded from gzipped Lottie JSON with `lottie-web`, rendered through
`canvas`/`jsdom`, and encoded as animated GIF with `gifenc` so QQ receives a format it supports.
Video stickers use ffmpeg when available to produce GIF and fall back to the original WebM
(`video/webm`) otherwise; the reply transform turns WebM items into OneBot `video` parts.
Administrators can choose GIF or still-thumbnail import per format. Masks and custom emoji are
skipped.

Importing and semantic classification are decoupled pipelines. Media import (download,
TGS/WebM conversion, SHA-256 dedupe, media storage, and the initial item upsert) runs in a
bounded worker pool (`importConcurrency`, default 4) while semantic classification runs in its
own bounded pool (`semanticConcurrency`, default 4). The semantic pool starts classifying each
item as soon as its media is stored, so it overlaps with the remaining downloads instead of
blocking them. When the active classifier is heuristic-only, the profile is computed inline and
the item is written once; no redundant second database write is made.

`telegram.import` awaits both stages by default so callers receive final `classified` counts and
vision-enriched descriptions. Passing `deferSemantic` (or `backgroundSemantic`) finishes the RPC
as soon as media import completes and launches a separate `semantic.reclassify` job, which is
tracked independently by the progress tracker.

Legacy local directory, ZIP/manifest, and DSH meme-pack imports remain available for
migrations. They use the same decoupled import/semantic pools, and DSH pack manifests are
scanned and imported in parallel. All import paths share media dedupe, tag validation,
disable-missing-media, and dry-run reporting.

## Semantic preprocessing

Every imported item is classified before it becomes selectable. The deterministic classifier
maps Telegram emoji (via `emojilib`) and multilingual pack-title terms onto a closed taxonomy of
emotions, intents, and tones, then writes searchable labels, keywords, and a model-safe
description. Administrators can select a specific host-registered model (`semanticProviderId` +
`semanticModel` via `context.models`) or configure custom OpenAI-compatible credentials
(`semanticBaseUrl`, `semanticApiKey`, `semanticModel`) for vision refinement. Vision output is
restricted to the same taxonomy, merged with the heuristic profile, and never stores a local
path or raw URL. Administrators can switch models and re-run classification for a pack from the
panel. Reclassification runs its own bounded worker pool and can execute at the same time as an
import.

Progress tracking keeps one job per running or recently settled operation. The `progress` RPC
returns `{ active, jobs }`, where `active` is the most relevant job and `jobs` lists every
running and recently settled job so the panel can render separate import and semantic progress
cards concurrently. The host status is only settled once all running jobs finish.

Exports contain manifests and media, but never user content or secrets.

## Selection

Model-facing tools (namespaced under `sticker-meme`):

1. `sticker-meme.search` — text/emotion/persona filtered candidates and metadata, including
   semantic labels and the owning pack name.
2. `sticker-meme.choose` — chooses one candidate and returns a transient send token.

Selection uses exact keyword, normalized text, semantic labels, emotion, persona, recent usage,
score, enabled state, and pack preference. Pack filters accept a pack id, display name, or tag,
so a pack imported during a live conversation is discoverable immediately. Query terms separated
by spaces or commas are alternatives, and taxonomy aliases are expanded in both directions, so
`ExamplePerson 丰川` or `疑惑` reach items whose stored labels are English. No deprecated packs or revoked
items are selectable.

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
4. Output batching keeps text/media ordering: every newline-separated text unit and every
   sticker becomes its own chat message, so a reply can send text, a sticker, and more text in
   between instead of packing everything into one message.
5. OneBot sends the sticker as a QQ native animated sticker (`image` segment with
   `sub_type=1` + `summary`), falling back to a plain image when `nativeSticker` is disabled.
6. Failure downgrades to text plus diagnostic, never injects binary data into text.

Model-visible text never includes absolute local paths or raw URLs.

## Admin UI

- pack list, enable/disable, persona assignment
- item grid with preview, tags, emotions, usage, score, and per-item delete
- bulk import/export
- candidate review approve/reject/delete
- usage/anonymized diagnostics
- destructive pack delete sits on the pack row and needs one confirmation click; bundle export
  stays a separate action

## Tests

1. Pack/item validation and migrations.
2. Telegram link parsing, mocked Bot API import, animated-thumbnail fallback, skip rules, dry
   run, stable ids, and media dedupe.
3. Import/semantic worker-pool overlap, concurrency bounds, deferred semantic jobs, and
   multi-job progress tracking.
4. Semantic taxonomy classification, emoji mapping, vision merge, and unsafe-label rejection.
5. Legacy import/export and media dedupe.
6. Selection ranking and policy filtering.
7. Token single-use/TTL/binding.
8. Output transformation, chunking, and failure fallback.
9. Learning/review workflow.
10. DSH meme-pack migration fixture.

## Acceptance

Tsukaima can import `https://t.me/addstickers/<name>` with one configured bot token, classify its
stickers semantically, select/send a sticker on QQ, review learned candidates, and prevent
unreviewed or unavailable media from being sent.
