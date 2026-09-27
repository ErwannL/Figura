export interface PublicRun {
  id: string;
  kind: 'journey' | 'volume' | 'replay' | 'explore';
  status: string;
  label: string;
  seed: number;
  targetUrl: string;
  /** Named Orqea target (FIGURA_TARGETS), when the run used one. */
  config?: {
    target?: string | null;
    targetUrl?: string;
    allowRemote?: boolean;
    confirmHost?: string | null;
    explorer?: Record<string, unknown> | null;
  };
  /** Explorer runs: live progress while running. */
  progress?: ExploreProgress | null;
  refusalCode: string | null;
  refusalMessage: string | null;
  error: string | null;
  createdAt: string;
  catalogueVersion: string | null;
  weightsVersion: string | null;
  targetVersion: string | null;
}

export interface Meta {
  personas: {
    id: string;
    displayName: string;
    locale: string;
    device: string;
    goal: string;
    weight: number;
  }[];
  catalogue: {
    version: string;
    useCases: { id: string; title: { en: string; fr: string }; planGate: string }[];
  };
  weightsVersion: string;
  scenarios: string[];
  explorer: {
    devices: { key: string; label: { en: string; fr: string } }[];
    caps: { sessions: number; maxActions: number; maxMinutes: number; clumsiness: number };
    defaults: { sessions: number; maxActions: number; maxMinutes: number; clumsiness: number };
  };
}

export interface ExploreProgress {
  sessions: { device: string; slot: number; step: number; states: number }[];
  states: number;
  anomalies: number;
  lastScreenshot: string | null;
  lastAction: string | null;
}

export interface ExploreAnomaly {
  key: string;
  type: string;
  severity: string;
  count: number;
  devices: string[];
  route: string;
  step: number;
  action: string;
  message: string;
  excerpt: string;
  screenshots: string[];
  replay: { seed: number; device: string; slot: number; untilStep: number };
}

/** GET /api/runs/:id/reports/explore.json (worker/explorer/report.ts). */
export interface ExploreReport {
  type: 'explore';
  seed: number;
  params: {
    devices: string[];
    sessions: number;
    maxActions: number;
    maxMinutes: number;
    seedData: boolean;
  };
  durationMs: number;
  sessions: {
    device: string;
    slot: number;
    account: string;
    steps: number;
    states: number;
    stoppedBy: string;
    error: string | null;
  }[];
  statesByDevice: Record<string, number>;
  routes: { route: string; devices: string[]; visits: number }[];
  gallery: { route: string; shots: Record<string, string> }[];
  anomalies: ExploreAnomaly[];
  info: { type: string; route: string; message: string; count: number }[];
  cleanup: { before: unknown; after: unknown; residualRows: number } | null;
}

export interface UiEvent {
  kind: string;
  personaId: string;
  simTime: string;
  useCaseId: string | null;
  attempt: number;
  friction: { score: number; reasons: { code: string; value: number }[] } | null;
  frustration: number;
  action: string | null;
  rule: string;
  facts: Record<string, number | boolean> | null;
  screenshot: string | null;
}

/** GET /api/me: the operator and the Orqea the admin console was inspecting at sign-in. */
export interface Me {
  operator: string;
  target: string | null;
  targetConfigured: boolean | null;
  targets: { name: string; api: string; web: string | null }[];
}
