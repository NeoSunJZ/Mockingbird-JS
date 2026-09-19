# Mockingbird: iterative response-data tracing

Mockingbird runs a configured browser scenario, boxes values read from a target API, and uses the resulting execution locations to add tracing to subsequent runs. It retains the original **boxing → observe → rewrite → replay** approach.

The runner now executes an unmodified baseline before tracing. It writes structured evidence and distinguishes a completed observation interval from unsupported propagation or a failed scenario. A successful run is not a proof that every use in the application has been covered, and this repository does not yet implement a complete EDE classifier.

## Install and run

Requires Node.js 20 or newer. The checked-in lockfile pins the tested dependencies.

```sh
npm ci
npx playwright install chromium
HEADLESS=1 node ede-killer.js test
```

Omit `HEADLESS=1` for a visible browser. `BROWSER_PATH` can select a compatible installed Chromium executable. Chromium is the supported browser because script interception uses CDP.

The default `test` configuration still expects the demo frontend and API to be running. The runner does not start those services. Either pass a name under `configs/` or an explicit `.config` path:

```sh
node ede-killer.js /absolute/path/scenario.config
```

Example configuration (LF and CRLF are accepted):

```text
TARGET /api/user
LOAD http://127.0.0.1:4173/
CLICK //button[@id='load']
WAIT_FOR_RESPONSE /api/user
WAIT_FOR_FUNCTION document.querySelector('#name').textContent.length > 0
```

An immediately following response/navigation/event wait is registered before the preceding action. Quoted selectors and input values are supported. Unknown commands and unsupported context/video/HAR operations fail explicitly. `GET_COOKIES`, `GET_LOCALSTORAGE`, and `GET_SESSIONSTORAGE` write command-result records. `COOKIE name=value` uses the current HTTP origin or the following `LOAD` origin.

Each round starts from a fresh browser context, with service workers blocked. Server-side state is not reset. Scenarios that mutate persistent server data or depend on changing responses may require a controlled test fixture.

## Output and status

Every invocation creates a fresh `logs/<scenario>-<timestamp>/` directory:

- `summary.json`: baseline comparisons, per-round results, script manifest, and coverage gaps.
- `cycle-<round>.jsonl`: full events with source, stack, code location, value IDs and parent IDs. Round `-1` is the baseline.
- `src/<id>.original.js`: original scripts, identified by full URL and content hash.
- `src/<id>.<generation>.js`: the exact rewritten scripts served to the browser.

A synthetic `mockingbird://scripts/...` source URL connects stack frames to the exact served generation. Redirects, query strings, identical basenames, `.mjs`, and other browser-classified script resources do not share positions accidentally.

Status meanings:

- `converged`: the configured observation interval settled, the checked snapshot matched the baseline, and no new supported sites or reported gaps remained.
- `incomplete`: an observed coverage gap, changed behavior, observation timeout, or round limit prevents a complete result.
- `failed`: a configuration, action, or runner operation failed.

The CLI exits nonzero for `incomplete` and `failed`. The baseline compares the active page's URL, title, body text and form values, and checks page errors. It does not prove equality of all network effects, storage, layout, timing, iframe contents or future interactions. Add explicit `WAIT_FOR_FUNCTION` assertions for the scenario's intended final state.

## Implementation

- `tools/runtime.js`: lazy primitive/object proxies; metadata in WeakMaps; source/value identities; explicit input gating; bounded event reporting.
- `tools/network.js`: target fetch/XHR readers, without body envelopes or replacing native Response/XHR constructors.
- `tools/tools.js`: Babel semantic protection, source-location analysis and iterative expression rewriting.
- `tools/scripts.js`: script identity, served generations and instrumentation candidates.
- `tools/intercept.js`: CDP response interception, including redirected script responses.
- `tools/sinks.js`: supported native DOM/storage boundaries; detached text provenance is consumed when attached.
- `tools/injected.js`: one atomic initialization payload per browser realm.
- `tools/command.js`: scenario actions and explicit failures.
- `ede-killer.js`: baseline, replay, settling, flush and reporting.

The first pass parses each intercepted script and inserts basic semantic adapters for conditions, logical operations, equality, `typeof`, `switch`, and selected native conversions. Propagation captures are still added iteratively at observed locations. The rewriter evaluates each input once and propagates only from those explicit inputs. Nested updates and outer assignments are analyzed separately; derived containers do not distribute their aggregate provenance to unrelated fields. Ordinary identifier/property `++` and `--` now preserve numeric conversion, prefix/postfix values and source metadata.

Use `globalThis.__mockingbird.meta(value)`, `.labels(value)` and `.raw(value)` to inspect tracer metadata. `_f_src` / `_f_from` are no longer injected into business objects. Origins use response occurrence IDs plus JSON Pointer paths; downstream consumers of the old `root[field]` log format need to migrate.

## Verification and limits

```sh
npm test
npm run test:browser
```

The browser tests serve isolated local fixtures. They include native response behavior, redirected ES modules, baseline/iteration checks, DOM sink accuracy, and React 19.1.1 / Vue 3.4.21 production rendering with a click update. No external application is needed for these tests.

See [current selection and propagation rules](docs/tracing-selection-and-propagation.md) and [current evidence](docs/input-gating-evidence.json) for the verified scope. The earlier [implementation status](docs/implementation-status.md) records the first repair round. Important remaining boundaries include `null`/`undefined` propagation, suspended expressions, arbitrary native APIs, custom classes/private fields, frozen properties, uninstrumented inline/eval/worker code, and conservative dependency merging. Metadata is not recovered by matching equal string values. Existing framework fixtures preserve rendering and reach DOM sinks, but still report `incomplete` for nullish propagation gaps.
