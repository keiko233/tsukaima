# Plugin framework comparison

Elaina needs a plugin system for bot domain hooks, tools, UI, and long-running tasks. We evaluated three sources rather than inventing all concepts from scratch:

1. **Cordis** — plugin lifecycle, dependency injection, event dispatch, configuration validation, hot reload, and service isolation.
2. **Pi coding-agent extensions** — tool/provider/MCP registration and lifecycle events for the coding plane.
3. **Pi Chord** — typed object contracts, live state, registries, reloadable facets, workers, and web plugins.

The chosen design keeps `pi-durable` as the conversation/task authority and adopts a small bot-domain plugin SDK. Cordis is a conceptual and partial implementation reference; it is not adopted as a direct dependency at this time.

## Cordis

Cordis is a meta-framework centered on a reactive Context, services, events, registry, fibers, and configurable components. Its current public core is `cordis@4.0.0-rc.12`, with API described as unstable by its own README. DSH vendors a fork (`@deepseek-ai/cordis`) at a different version, so DSH plugin compatibility cannot be assumed.

Useful Cordis concepts:

| Concept | Value to Elaina |
| --- | --- |
| Component lifecycle | Start/dispose semantics for plugin resources |
| Service dependency injection | Explicit dependency declaration for domain services |
| Event dispatch modes | Decide serial, parallel, bail, and waterfall semantics per hook |
| Standard-schema config validation | Manifest/config validation without lock-in |
| Fiber replacement | Safer plugin reload boundary |
| Isolation realms | Prevent plugins from silently sharing services |
| Loader entry tree | Declarative plugin groups and config reloads |
| Config interpolation | Useful idea, but too much surface for first release |

Risks:

- Unstable RC API.
- Generic meta-framework abstraction is broader than bot needs.
- Direct dependency would couple Elaina's core to Cordis services, proxies, fibers, and event semantics.
- DSH plugins target a forked Cordis generation and DSH host APIs, not the public Cordis core.

## Pi coding-agent extensions

Pi coding-agent extensions provide a mature agent-side extension API: tools, commands, flags, lifecycle events, custom providers, MCP registration, custom message/entry rendering, and session state through custom entries.

Elaina uses Pi concepts in the coding/self-iteration plane, but Pi is not the bot plugin framework:

| Pi concept | Elaina use |
| --- | --- |
| `registerTool` | Model-facing tool contract shape |
| lifecycle events | Agent/session/tool lifecycle hooks |
| provider registration | Coding/runtime provider registration |
| MCP registration | External tool integration |
| custom entry/message | Coding session diagnostics/UI state |

Bot conversations still need user identity, channel policy, persona, activity aggregation, memory scope, and outbound IM actions. Those belong to the Elaina plugin SDK, not a generic coding agent extension API.

## Pi Chord

Chord is relevant to reloadable application objects and cross-process plugin surfaces:

| Chord concept | Value to Elaina |
| --- | --- |
| typed contracts | Strong API for plugin-owned objects |
| registries | Contributing panels/tools/routes |
| live state / derives | Watchable state for UI |
| reload | Replace plugin code without losing durable state |
| workers | Isolate plugin execution |
| plugin API package | Versioned SDK boundary |
| web facets | Plugin UI assets |

Chord is more ambitious than needed for the first release and overlaps with Elysia/oRPC/TanStack for HTTP and UI. We do not adopt Chord wholesale now. It remains a reference for:

1. versioned plugin API packages (`@elaina/app/v1`)
2. contracts for plugin-provided state/actions
3. worker lifecycle and reload behavior
4. registries as data, not arbitrary component injection
5. UI declarations rather than raw DOM/control-plane access

If Elaina's plugin ecosystem needs full cross-process typed objects and reload rollouts later, Chord can be revisited without changing durable conversation storage.

## Decision

Use a small Elaina plugin SDK and borrow selectively:

- From Cordis: lifecycle/dispose, typed config validation, event modes, explicit service injection, plugin isolation, and reload boundaries.
- From Pi coding-agent: tool/provider/MCP registration semantics for the coding plane.
- From Chord: API versioning, worker/reload model, typed UI registries, and data-only UI declarations.

Do not:

- depend on Cordis RC in the core runtime
- treat DSH plugins as Cordis-compatible
- expose Cordis Context directly to plugin authors
- use Pi coding-agent extensions as the bot conversation plugin API
- replace Elysia/oRPC with Chord HTTP/surfaces in phase 1

The SDK is intentionally narrower than Cordis or Chord. It is defined in `plugin-sdk.md`. Generic internals may use small custom abstractions, but plugin authors see only stable typed APIs.

## Future evolution

Re-evaluate direct adoption when:

1. Cordis reaches stable API and proves Bun compatibility.
2. Elaina needs many independent worker objects with cross-process live state.
3. Plugin reload requires coordinated rollout across hosts.
4. Plugin authors need a larger object/contract ecosystem than Elaina's own SDK provides.

Until then, plugin definitions remain declarative and versioned:

```ts
type ElainaPlugin = {
  manifest: PluginManifest;
  setup(context: PluginContext): Promise<void>;
  teardown?(context: PluginContext): Promise<void>;
};
```

and UI/route/tool contributions remain data validated by the host.
