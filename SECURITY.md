# Security

## Reporting a vulnerability

Report privately through GitHub's **[private vulnerability reporting](https://github.com/celikgo/blaeu-lib/security/advisories/new)** — the Security tab of this repository, "Report a vulnerability". Please do not open a public issue for anything you believe is exploitable; a public issue is a disclosure, and this project has one maintainer rather than a rota, so there is nobody to race you to a fix.

Expect a first response within a week. Blaeu is a pre-1.0 project maintained by one person in their own time, and an honest interval is more useful to you than a service-level promise nobody is on call to keep. If a report is confirmed, the fix ships in a patch release with a GitHub Security Advisory; if it is not, you will get the reasoning rather than silence.

## Supported versions

| Version | Supported                     |
| ------- | ----------------------------- |
| 0.1.x   | Yes — the only supported line |
| < 0.1   | No                            |

Blaeu is pre-1.0. There is no LTS line and no backport policy: fixes land on the current 0.1.x and you upgrade forward. Because the project is pre-1.0, a security fix may arrive alongside a breaking change if the vulnerable behaviour is the contract itself — that is the cost of using a kernel before its API has settled, and it is worth stating plainly rather than discovering during an incident.

## Threat model

Blaeu is a client-side editing kernel. It has no server, no network listener and no credential store, so the interesting surface is not a protocol — it is everything the kernel is handed by somebody else.

**Third-party GeoJSON is the normal case, not the edge case.** A cadastral kernel ingests data produced by other people's software, so malformed input is what arrives on an ordinary Tuesday. `packages/core/src/hostile-input.test.ts` exists for exactly this, and its assertions are pointed at the property that matters: not that a bad call reported failure, but that it did not corrupt the store on its way out. Unknown geometry types, lower-cased type names, null and missing geometries, two-point rings, empty rings and non-finite ordinates are all rejected at the ingest gate; a mid-batch failure writes none of the batch; and `restore()` on a snapshot carrying an unmeasurable geometry leaves the store exactly as it was. Prototype-pollution vectors are covered in the same file — a `__proto__` key in a property patch becomes an own property and does not move the prototype, and a collection literally named `__proto__` survives a snapshot round-trip. If you find input that gets past the gate, or that gets rejected while leaving the store in a state that is not the state it started in, that is a security report and not a bug report.

**Untrusted proj4 CRS definitions are parsed.** `map.crs.register({ code, name, proj4, … })` hands a definition string to proj4, which is a parser over a format the kernel does not itself validate. The kernel round-trip probes a newly registered definition rather than trusting it, because proj4 does not reliably throw on a malformed definition — it can return a converter that silently produces wrong coordinates, and wrong coordinates in a land-registry context are a defect with legal consequences rather than a rendering artefact. Treat a CRS definition from an untrusted source with the same suspicion as the geometry it describes.

**Plugin code is not sandboxed.** A plugin receives a `PluginContext` holding the store, the command bus, the renderer, the layer and tool managers, the CRS service and an escape hatch to the whole map. There is no capability system and no isolation boundary; a plugin runs with the privileges of the page that loaded it. Installing a third-party Blaeu plugin is exactly as consequential as adding any other dependency to your bundle, and no more contained. This is a design position rather than an oversight — the plugin tier is where capability lives, and a sandbox that could not reach the store could not implement snapping — but it means "a malicious plugin can do X" is expected behaviour, not a vulnerability.

**Out of scope.** Denial of service from a deliberately enormous or pathological geometry: the kernel is synchronous at pointer frequency by contract, and a caller who feeds it a million-vertex ring will freeze their own tab. Vulnerabilities in maplibre-gl, proj4, JSTS or any other dependency belong upstream — report them there, and open an issue here only if Blaeu's use of the library makes an upstream issue reachable in a way the library's own documented usage would not.
