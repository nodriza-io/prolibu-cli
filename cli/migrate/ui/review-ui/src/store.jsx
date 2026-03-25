import { createContext, useContext, useReducer, useEffect } from "react";
import { fetchState, fetchPipelines } from "./api";

const MigrationContext = createContext(null);

const initialState = {
  loading: true,
  error: null,

  // From /api/state
  domain: "",
  crmLabel: "",
  discovery: null,
  config: {},
  prolibuSpec: null,
  sfToProlibu: {},
  fieldMapping: {},
  paths: {},
  hasCredentials: false,
  hasDiscovery: false,
  hasConfig: false,

  // Config being built (live)
  cfg: { entities: {}, customObjects: {}, batchSize: 200 },

  // Setup being built (live)
  setup: { customObjects: [], customFields: [] },

  // Pipelines
  pipelines: {},

  // Execution
  execution: {
    running: false,
    dryRun: true,
    logs: [],
    results: {},
    progress: {},
  },
};

function reducer(state, action) {
  switch (action.type) {
    case "INIT":
      return {
        ...state,
        loading: false,
        domain: action.payload.domain,
        crmLabel: action.payload.crmLabel || "",
        discovery: action.payload.discovery,
        config: action.payload.config || {},
        prolibuSpec: action.payload.prolibuSpec,
        sfToProlibu: action.payload.sfToProlibu || {},
        fieldMapping: action.payload.fieldMapping || {},
        paths: action.payload.paths || {},
        hasCredentials: action.payload.hasCredentials || false,
        hasDiscovery: action.payload.hasDiscovery || !!action.payload.discovery,
        hasConfig: action.payload.hasConfig || false,
        cfg: {
          entities: {},
          customObjects: {},
          batchSize: 200,
          ...(action.payload.config || {}),
        },
      };

    case "INIT_ERROR":
      return { ...state, loading: false, error: action.payload };

    case "SET_CFG":
      return { ...state, cfg: action.payload };

    case "UPDATE_CFG":
      return { ...state, cfg: { ...state.cfg, ...action.payload } };

    case "SET_ENTITY_CFG": {
      const { key, value } = action.payload;
      return {
        ...state,
        cfg: {
          ...state.cfg,
          entities: { ...state.cfg.entities, [key]: value },
        },
      };
    }

    case "SET_CUSTOM_OBJ_CFG": {
      const { sfName, value } = action.payload;
      return {
        ...state,
        cfg: {
          ...state.cfg,
          customObjects: { ...state.cfg.customObjects, [sfName]: value },
        },
      };
    }

    case "SET_SETUP":
      return { ...state, setup: action.payload };

    case "SET_PIPELINES":
      return { ...state, pipelines: action.payload };

    case "SET_EXECUTION":
      return {
        ...state,
        execution: { ...state.execution, ...action.payload },
      };

    case "APPEND_LOG":
      return {
        ...state,
        execution: {
          ...state.execution,
          logs: [...state.execution.logs, action.payload],
        },
      };

    case "SET_ENTITY_RESULT": {
      const { entity, result } = action.payload;
      // Remove from progress when result arrives
      const { [entity]: _, ...remainingProgress } = state.execution.progress;
      return {
        ...state,
        execution: {
          ...state.execution,
          results: { ...state.execution.results, [entity]: result },
          progress: remainingProgress,
        },
      };
    }

    case "SET_ENTITY_PROGRESS": {
      const { entity, ...progressData } = action.payload;
      return {
        ...state,
        execution: {
          ...state.execution,
          progress: { ...state.execution.progress, [entity]: progressData },
        },
      };
    }

    default:
      return state;
  }
}

export function MigrationProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    fetchState()
      .then((data) => dispatch({ type: "INIT", payload: data }))
      .catch((err) => dispatch({ type: "INIT_ERROR", payload: err.message }));
  }, []);

  // Load pipelines after state is ready
  useEffect(() => {
    if (!state.loading && state.domain) {
      fetchPipelines()
        .then((data) => dispatch({ type: "SET_PIPELINES", payload: data }))
        .catch(() => {}); // non-critical
    }
  }, [state.loading, state.domain]);

  return (
    <MigrationContext.Provider value={{ state, dispatch }}>
      {children}
    </MigrationContext.Provider>
  );
}

export function useMigration() {
  const ctx = useContext(MigrationContext);
  if (!ctx)
    throw new Error("useMigration must be used within MigrationProvider");
  return ctx;
}
