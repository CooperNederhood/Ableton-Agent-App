export type InspectorModuleId = "selection" | "plan" | "approval";

export interface InspectorPane {
  readonly id: string;
  readonly tabs: readonly InspectorModuleId[];
  readonly activeTab: InspectorModuleId;
  readonly weight: number;
}

export interface InspectorLayoutState {
  readonly panes: readonly InspectorPane[];
  readonly available: readonly InspectorModuleId[];
  readonly closed: readonly InspectorModuleId[];
  readonly focusedPaneId: string | undefined;
  readonly nextPaneId: number;
}

export type InspectorLayoutAction =
  | {
      readonly type: "reconcile";
      readonly available: readonly InspectorModuleId[];
    }
  | {
      readonly type: "activate";
      readonly paneId: string;
      readonly moduleId: InspectorModuleId;
    }
  | {
      readonly type: "focus";
      readonly paneId: string;
    }
  | {
      readonly type: "close";
      readonly moduleId: InspectorModuleId;
    }
  | {
      readonly type: "add";
      readonly moduleId: InspectorModuleId;
      readonly paneId?: string;
    }
  | {
      readonly type: "move";
      readonly moduleId: InspectorModuleId;
      readonly paneId: string;
      readonly index?: number;
    }
  | {
      readonly type: "split";
      readonly moduleId: InspectorModuleId;
      readonly paneId: string;
      readonly edge: "before" | "after";
    }
  | {
      readonly type: "resize";
      readonly dividerIndex: number;
      readonly delta: number;
      readonly minimumWeight: number;
    };

const unique = <Value>(values: readonly Value[]): Value[] => [
  ...new Set(values),
];

function uniformWeights(panes: readonly InspectorPane[]): InspectorPane[] {
  if (panes.length === 0) return [];
  const weight = 1 / panes.length;
  return panes.map((pane) => ({ ...pane, weight }));
}

function normalizedWeights(panes: readonly InspectorPane[]): InspectorPane[] {
  const total = panes.reduce((sum, pane) => sum + pane.weight, 0);
  if (panes.length === 0 || total <= 0) return uniformWeights(panes);
  return panes.map((pane) => ({ ...pane, weight: pane.weight / total }));
}

function removeModule(
  panes: readonly InspectorPane[],
  moduleId: InspectorModuleId,
): InspectorPane[] {
  return panes.flatMap((pane) => {
    if (!pane.tabs.includes(moduleId)) return [pane];
    const tabs = pane.tabs.filter((tab) => tab !== moduleId);
    if (tabs.length === 0) return [];
    return [
      {
        ...pane,
        tabs,
        activeTab:
          pane.activeTab === moduleId
            ? (tabs[0] as InspectorModuleId)
            : pane.activeTab,
      },
    ];
  });
}

function withFocusedPane(
  state: InspectorLayoutState,
  panes: readonly InspectorPane[],
  preferredPaneId?: string,
): InspectorLayoutState {
  const focusedPaneId =
    panes.find(({ id }) => id === preferredPaneId)?.id ??
    panes.find(({ id }) => id === state.focusedPaneId)?.id ??
    panes[0]?.id;
  return { ...state, panes, focusedPaneId };
}

function addToPane(
  state: InspectorLayoutState,
  moduleId: InspectorModuleId,
  paneId = state.focusedPaneId,
): InspectorLayoutState {
  if (!state.available.includes(moduleId)) return state;
  const withoutModule = removeModule(state.panes, moduleId);
  const target =
    withoutModule.find(({ id }) => id === paneId) ?? withoutModule[0];
  if (target === undefined) {
    const id = `inspector-pane-${state.nextPaneId}`;
    return {
      ...state,
      panes: [{ id, tabs: [moduleId], activeTab: moduleId, weight: 1 }],
      closed: state.closed.filter((candidate) => candidate !== moduleId),
      focusedPaneId: id,
      nextPaneId: state.nextPaneId + 1,
    };
  }
  return {
    ...withFocusedPane(
      state,
      withoutModule.map((pane) =>
        pane.id === target.id
          ? {
              ...pane,
              tabs: [...pane.tabs, moduleId],
              activeTab: moduleId,
            }
          : pane,
      ),
      target.id,
    ),
    closed: state.closed.filter((candidate) => candidate !== moduleId),
  };
}

export function createInspectorLayout(
  available: readonly InspectorModuleId[],
): InspectorLayoutState {
  const modules = unique(available);
  if (modules.length === 0) {
    return {
      panes: [],
      available: [],
      closed: [],
      focusedPaneId: undefined,
      nextPaneId: 1,
    };
  }
  return {
    panes: [
      {
        id: "inspector-pane-0",
        tabs: modules,
        activeTab: modules[0] as InspectorModuleId,
        weight: 1,
      },
    ],
    available: modules,
    closed: [],
    focusedPaneId: "inspector-pane-0",
    nextPaneId: 1,
  };
}

export function inspectorLayoutReducer(
  state: InspectorLayoutState,
  action: InspectorLayoutAction,
): InspectorLayoutState {
  if (action.type === "reconcile") {
    const available = unique(action.available);
    const availableSet = new Set(available);
    const newlyAvailable = available.filter(
      (moduleId) => !state.available.includes(moduleId),
    );
    let next: InspectorLayoutState = {
      ...withFocusedPane(
        state,
        normalizedWeights(
          state.panes.flatMap((pane) => {
            const tabs = pane.tabs.filter((tab) => availableSet.has(tab));
            if (tabs.length === 0) return [];
            return [
              {
                ...pane,
                tabs,
                activeTab: tabs.includes(pane.activeTab)
                  ? pane.activeTab
                  : (tabs[0] as InspectorModuleId),
              },
            ];
          }),
        ),
      ),
      available,
      closed: state.closed.filter((moduleId) => availableSet.has(moduleId)),
    };
    for (const moduleId of newlyAvailable) next = addToPane(next, moduleId);
    return next;
  }
  if (action.type === "activate") {
    if (
      !state.panes.some(
        ({ id, tabs }) =>
          id === action.paneId && tabs.includes(action.moduleId),
      )
    ) {
      return state;
    }
    return {
      ...state,
      panes: state.panes.map((pane) =>
        pane.id === action.paneId
          ? { ...pane, activeTab: action.moduleId }
          : pane,
      ),
      focusedPaneId: action.paneId,
    };
  }
  if (action.type === "focus") {
    return state.panes.some(({ id }) => id === action.paneId)
      ? { ...state, focusedPaneId: action.paneId }
      : state;
  }
  if (action.type === "close") {
    if (!state.panes.some(({ tabs }) => tabs.includes(action.moduleId))) {
      return state;
    }
    const panes = removeModule(state.panes, action.moduleId);
    return {
      ...withFocusedPane(
        state,
        panes.length === state.panes.length ? panes : normalizedWeights(panes),
      ),
      closed: unique([...state.closed, action.moduleId]),
    };
  }
  if (action.type === "add") {
    return addToPane(state, action.moduleId, action.paneId);
  }
  if (action.type === "move") {
    const target = state.panes.find(({ id }) => id === action.paneId);
    if (target === undefined || !state.available.includes(action.moduleId)) {
      return state;
    }
    if (target.tabs.includes(action.moduleId)) {
      const tabs = target.tabs.filter((tab) => tab !== action.moduleId);
      const index = Math.max(
        0,
        Math.min(action.index ?? tabs.length, tabs.length),
      );
      tabs.splice(index, 0, action.moduleId);
      return {
        ...state,
        panes: state.panes.map((pane) =>
          pane.id === target.id
            ? { ...pane, tabs, activeTab: action.moduleId }
            : pane,
        ),
        focusedPaneId: target.id,
      };
    }
    const withoutModule = removeModule(state.panes, action.moduleId);
    const nextTarget = withoutModule.find(({ id }) => id === action.paneId);
    if (nextTarget === undefined) return state;
    const tabs = [...nextTarget.tabs];
    tabs.splice(
      Math.max(0, Math.min(action.index ?? tabs.length, tabs.length)),
      0,
      action.moduleId,
    );
    return {
      ...withFocusedPane(
        state,
        withoutModule.length === state.panes.length
          ? withoutModule.map((pane) =>
              pane.id === nextTarget.id
                ? { ...pane, tabs, activeTab: action.moduleId }
                : pane,
            )
          : normalizedWeights(
              withoutModule.map((pane) =>
                pane.id === nextTarget.id
                  ? { ...pane, tabs, activeTab: action.moduleId }
                  : pane,
              ),
            ),
        nextTarget.id,
      ),
      closed: state.closed.filter((candidate) => candidate !== action.moduleId),
    };
  }
  if (action.type === "split") {
    if (
      !state.available.includes(action.moduleId) ||
      !state.panes.some(({ id }) => id === action.paneId)
    ) {
      return state;
    }
    const withoutModule = removeModule(state.panes, action.moduleId);
    const targetIndex = withoutModule.findIndex(
      ({ id }) => id === action.paneId,
    );
    if (targetIndex < 0) return state;
    const id = `inspector-pane-${state.nextPaneId}`;
    const insertionIndex =
      action.edge === "before" ? targetIndex : targetIndex + 1;
    const panes = [...withoutModule];
    panes.splice(insertionIndex, 0, {
      id,
      tabs: [action.moduleId],
      activeTab: action.moduleId,
      weight: 1,
    });
    return {
      ...state,
      panes: uniformWeights(panes),
      closed: state.closed.filter((candidate) => candidate !== action.moduleId),
      focusedPaneId: id,
      nextPaneId: state.nextPaneId + 1,
    };
  }
  if (action.type === "resize") {
    const before = state.panes[action.dividerIndex];
    const after = state.panes[action.dividerIndex + 1];
    if (before === undefined || after === undefined) return state;
    const delta = Math.max(
      action.minimumWeight - before.weight,
      Math.min(action.delta, after.weight - action.minimumWeight),
    );
    if (delta === 0) return state;
    return {
      ...state,
      panes: state.panes.map((pane, index) =>
        index === action.dividerIndex
          ? { ...pane, weight: pane.weight + delta }
          : index === action.dividerIndex + 1
            ? { ...pane, weight: pane.weight - delta }
            : pane,
      ),
    };
  }
  return state;
}

export function openInspectorModules(
  state: InspectorLayoutState,
): InspectorModuleId[] {
  return state.panes.flatMap(({ tabs }) => tabs);
}
