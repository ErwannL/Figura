# worker/explorer

Explorer mode (`kind: "explore"`, [docs/EXPLORATEUR.md](../../docs/EXPLORATEUR.md)): synthetic
personas explore Orqea's web app on several devices, screenshot every new screen and record
anomalies with their evidence.

| File             | Role                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| `forbidden.ts`   | Catalogue of controls never activated (structure first, English names second)   |
| `page-scan.ts`   | In-page inventory and DOM detectors (serialised; tested in happy-dom)           |
| `fingerprint.ts` | Route normalisation (`:id`), state fingerprint, action keys                     |
| `strategy.ts`    | State model, novelty-weighted seeded choice, recovery                           |
| `values.ts`      | Field values, plausible and edge cases                                          |
| `missions.ts`    | Missions = catalogue use cases; seed data; prerequisites                        |
| `anomalies.ts`   | Anomaly book (dedup, severity), info records, secret redaction                  |
| `session.ts`     | One session on a Playwright page: scan, detect, decide, act, screenshot         |
| `shots.ts`       | PNG screenshots (one per state × device, evidence per anomaly), retention       |
| `report.ts`      | The `explore` report: states per device, route map, gallery, anomalies, cleanup |
| `run.ts`         | The run: sessions in parallel (≤ 3), accounts via the replayer, progress        |

Every random choice goes through the session's PRNG (`createPrng(seed).fork("<device>#<slot>")`).
