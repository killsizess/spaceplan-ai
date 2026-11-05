"use client";

import { chooseLanguage, currentLanguage, tr, untranslated } from "@/lib/i18n";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ClipboardCheck,
  FileCheck2,
  ScanSearch,
  CircleHelp,
  Focus,
  Grid2X2,
  Layers2,
  MousePointer2,
  Plus,
  Redo2,
  Undo2,
  X,
  Download,
  Upload,
  FolderOpen,
  BrickWall,
  Box,
  FileImage,
  GitBranch,
  GitCompare,
} from "lucide-react";
import {
  createDefaultRoom,
  getTotalArea,
} from "@/domain/floor-plan/operations";
import { countsInTotal, type FloorPlan, type Opening, type Room, type Underlay, type Wall } from "@/domain/floor-plan/types";
import { calibrateUnderlay } from "@/domain/floor-plan/construction";
import { DEFAULT_DOOR_SWING } from "@/domain/floor-plan/door-swing";
import type { DoorWallCollision } from "@/domain/floor-plan/door-collisions";
import type { DoorPairCollision } from "@/domain/floor-plan/door-pair-collisions";
import type { PlanDiagnosticItem } from "@/domain/floor-plan/plan-diagnostics";
import type { WallConnectionDiagnostic } from "@/domain/floor-plan/wall-diagnostics";
import type { WallIntersectionDiagnostic } from "@/domain/floor-plan/wall-intersections";
import type { WallOverlapDiagnostic } from "@/domain/floor-plan/wall-overlaps";
import { createSpatialExamplePlan } from "@/domain/floor-plan/examples";
import { rulesForPlan } from "@/domain/rules/engine";
import { createVariantsExamplePlan } from "@/domain/generation/example-flat";
import { planAskingToRemove } from "@/domain/generation/generate-variants";
import { createPlanOrigin } from "@/domain/floor-plan/plan-origin";
import { createRulesExamplePlan } from "@/domain/rules/example-apartment";
import { startedAsExample, WelcomeStrip } from "./components/welcome-strip";
import { getRectangularRoomWalls, type RectangularWallRoomInput } from "@/domain/floor-plan/rectangular-wall-room";
import { wallLength, type Point } from "@/domain/geometry";
import { formatLength, pluralRu } from "@/lib/format";
import { NewProjectDialog } from "@/features/projects/new-project-dialog";
import { ProjectsDialog } from "@/features/projects/projects-dialog";
import { useProjectWorkspace } from "@/features/projects/use-project-workspace";
import {
  MAX_PLAN_FILE_BYTES,
  makeExportFilename,
  serializePlan,
} from "@/features/projects/project-repository";
import { RoomProperties } from "./components/room-properties";
import { WallRoomProperties } from "./components/wall-room-properties";
import { WallKindLegend, WallKindSummary, WallList } from "./components/wall-list";
import { PlanSummary, RoomList } from "./components/room-list";
import { CanvasBottom, DrawingTools, ViewMenu, type ViewLayers } from "./components/canvas-controls";
import { CanvasEmpty, HelpCard, NothingSelected, ToolInstruction, workspaceHint } from "./components/editor-hints";
import { detectViewRooms, roomNeighbours } from "./view-rooms";
import { usePlanDiagnostics } from "./use-plan-diagnostics";
import { useEditorShortcuts } from "./use-editor-shortcuts";
import { findRoomAdjacency } from "@/domain/floor-plan/room-adjacency";
import { evaluateRequirements, findRequirementConflicts, violatingRoomIds } from "@/domain/floor-plan/plan-requirements";
import { RequirementsPanel } from "./components/requirements-panel";
import { UnassignedRoomLabels } from "./components/unassigned-room-labels";
import { RectangularRoomDialog } from "./components/rectangular-room-dialog";
import { UnderlayPanel } from "./components/underlay-panel";
import { PdfWallSuggestions } from "./components/pdf-wall-suggestions";
import { APP_VERSION } from "@/lib/app-version";
import { bearingChangeMessage } from "./bearing-guard";
import { ScenarioRail } from "./components/scenario-rail";
import { scenarioSteps, type ScenarioStepId } from "./scenario-steps";
import { UnresolvedRoomsNotice } from "./components/unresolved-rooms-notice";
import type { EditorAction } from "./editor-state";
import { findWallCandidates, type WallCandidate } from "@/domain/floor-plan/wall-candidates";
import { findOpeningCandidates, openingFromCandidate, type OpeningCandidate } from "@/domain/floor-plan/opening-candidates";
import { PdfOpeningSuggestions } from "./components/pdf-opening-suggestions";
import type { PdfLines } from "./pdf-vector-lines";
import { ConstructionProperties } from "./components/construction-properties";
import { WallConnectionsPanel } from "./components/wall-connections-panel";
import { WallIntersectionsPanel } from "./components/wall-intersections-panel";
import { DoorCollisionsPanel } from "./components/door-collisions-panel";
import { CalibrationDialog } from "./components/calibration-dialog";
import { readUnderlayImage } from "./underlay-image";
import type { EditorTool } from "./editor-tools";
import "./editor-construction.css";
import "./wall-rooms.css";
import "./plan-export.css";
import "./plan-check.css";

const PlanCanvas = dynamic(() => import("./components/plan-canvas"), {
  ssr: false,
  loading: () => (
    <div className="canvas-loading">{tr`Подготавливаем рабочее пространство…`}</div>
  ),
});
const PlanThree = dynamic(() => import("./components/plan-three"), {
  ssr: false,
  loading: () => <div className="canvas-loading">{tr`Подготавливаем 3D…`}</div>,
});
const PdfImportDialog = dynamic(
  () => import("./components/pdf-import-dialog"),
  {
    ssr: false,
  },
);
const DxfImportDialog = dynamic(() => import("./components/dxf-import-dialog"), {
  ssr: false,
});
const PlanExportDialog = dynamic(() => import("./components/plan-export-dialog"), {
  ssr: false,
});
const PlanCheckDialog = dynamic(() => import("./components/plan-check-dialog"), {
  ssr: false,
});
const PlanCompareDialog = dynamic(() => import("./components/plan-compare-dialog"), {
  ssr: false,
});
const PlanProofDialog = dynamic(() => import("../proof/plan-proof-dialog"), {
  ssr: false,
});
const PlanVariantsDialog = dynamic(() => import("../generation/plan-variants-dialog"), {
  ssr: false,
});
const PlanXrayDialog = dynamic(() => import("../xray/plan-xray-dialog"), {
  ssr: false,
});
const PlanReportDialog = dynamic(() => import("../report/plan-report-dialog"), {
  ssr: false,
});

export default function Editor() {
  const { workspace, snapshot } = useProjectWorkspace();
  const state = snapshot.editor;
  // A bearing wall is never moved, deleted or unmarked without the user confirming it first.
  const dispatch = useCallback((action: EditorAction) => {
    const message = bearingChangeMessage(workspace.getSnapshot().editor, action);
    if (message && !window.confirm(message)) return;
    workspace.dispatch(action);
  }, [workspace]);
  const importRef = useRef<HTMLInputElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const libraryButtonRef = useRef<HTMLButtonElement>(null);
  const planCheckButtonRef = useRef<HTMLButtonElement>(null);
  const [planCheckOpen, setPlanCheckOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [xrayOpen, setXrayOpen] = useState(false);
  const [variantsOpen, setVariantsOpen] = useState(false);
  /** `label` marks a plan nobody has saved yet, and names it if someone does. */
  const [proof, setProof] = useState<{ plan: FloorPlan; question?: string; label?: string } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const [exportPlan, setExportPlan] = useState<FloorPlan | null>(null);
  // A changed snapshot ends this session permanently, even if Undo restores its object.
  if (exportPlan && exportPlan !== state.plan) setExportPlan(null);
  const activeExport = exportPlan === state.plan ? exportPlan : null;
  const [tool, setTool] = useState<EditorTool>("select");
  const [viewMode, setViewMode] = useState<"2d" | "3d">("2d");
  const [sidebar, setSidebar] = useState<"rooms" | "source" | "structure">(
    "rooms",
  );
  const [imageBusy, setImageBusy] = useState(false);
  const uploadGeneration = useRef(0);
  const [pdfImport, setPdfImport] = useState<{
    file: File;
    plan: FloorPlan;
    generation: number;
  } | null>(null);
  const activePdfImport = pdfImport?.plan === state.plan ? pdfImport : null;
  const [dxfImport, setDxfImport] = useState<{
    file: File;
    plan: FloorPlan;
    generation: number;
  } | null>(null);
  const activeDxfImport = dxfImport?.plan === state.plan ? dxfImport : null;
  // Vector lines of the imported PDF page live only in this session, for the underlay
  // they came with: replacing the image ends them, calibration and moving do not.
  const [pdfLines, setPdfLines] = useState<{ dataUrl: string; lines: PdfLines } | null>(null);
  const activePdfLines =
    pdfLines && state.plan.underlay?.dataUrl === pdfLines.dataUrl ? pdfLines.lines : null;
  // Suggested walls belong to the plan they were computed for; any edit retires them.
  const [wallSuggestion, setWallSuggestion] = useState<{
    plan: FloorPlan;
    candidates: WallCandidate[];
    /** Per candidate: will it be added. All start selected. */
    selected: boolean[];
    truncated: boolean;
  } | null>(null);
  const activeSuggestion = wallSuggestion?.plan === state.plan ? wallSuggestion : null;
  // Suggested doors and windows likewise belong to the plan they were computed for.
  const [openingSuggestion, setOpeningSuggestion] = useState<{
    plan: FloorPlan;
    candidates: OpeningCandidate[];
    /** Per candidate: the kind it will be added as (the user may change a doubtful one). */
    kinds: ("door" | "window")[];
    /** Per candidate: will it be added. Only the confident ones start selected. */
    selected: boolean[];
    truncated: boolean;
  } | null>(null);
  const activeOpeningSuggestion = openingSuggestion?.plan === state.plan ? openingSuggestion : null;
  const toggleOpeningCandidate = useCallback((index: number) => {
    setOpeningSuggestion((current) => current && index >= 0 && index < current.selected.length
      ? { ...current, selected: current.selected.map((value, at) => (at === index ? !value : value)) }
      : current);
  }, []);
  const toggleCandidate = useCallback((index: number) => {
    setWallSuggestion((current) => current && index >= 0 && index < current.selected.length
      ? { ...current, selected: current.selected.map((value, at) => (at === index ? !value : value)) }
      : current);
  }, []);
  useEffect(
    () => () => {
      uploadGeneration.current += 1;
    },
    [],
  );
  const [calibration, setCalibration] = useState<{
    start: Point;
    end: Point;
    underlay: Underlay;
    projectId: string;
  } | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [layers, setLayers] = useState<ViewLayers>({
    grid: true,
    dimensions: true,
    connections: true,
    intersections: true,
    doorCollisions: true,
  });
  const showLayer = useCallback(
    (layer: keyof ViewLayers, visible = true) =>
      setLayers((current) => (current[layer] === visible ? current : { ...current, [layer]: visible })),
    [],
  );
  // Whole-wall moves keep other walls' directions (CAD-style offset) when possible.
  const [keepDirections, setKeepDirections] = useState(true);
  const [connectionFocus, setConnectionFocus] = useState<{
    plan: FloorPlan;
    point: Point;
    request: number;
  } | null>(null);
  const connectionFocusRequest = useRef(0);
  const {
    connections: connectionDiagnostics,
    intersections: intersectionAnalysis,
    overlaps: overlapAnalysis,
    doorWalls: doorCollisionAnalysis,
    doorPairs: doorPairAnalysis,
    report: planDiagnostics,
  } = usePlanDiagnostics(state.plan);
  const [fitViewKey, setFitViewKey] = useState(0);
  const [newProject, setNewProject] = useState(false);
  const [newRectangle, setNewRectangle] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const closePopovers = useCallback(() => {
    setViewOpen(false);
    setHelpOpen(false);
  }, []);
  const enter2D = useCallback((nextTool: EditorTool = "select") => {
    setConnectionFocus(null);
    setViewMode("2d");
    setTool(nextTool);
    closePopovers();
  }, [closePopovers]);
  const enter3D = () => {
    setConnectionFocus(null);
    setViewMode("3d");
    setTool("select");
    closePopovers();
  };
  const locateConnection = (diagnostic: WallConnectionDiagnostic) => {
    if (!snapshot.ready || snapshot.busy) return;
    enter2D();
    showLayer("connections");
    dispatch({ type: "select", id: diagnostic.wallId });
    setConnectionFocus({
      plan: state.plan,
      point: diagnostic.point,
      request: ++connectionFocusRequest.current,
    });
  };
  const locateIntersection = (diagnostic: WallIntersectionDiagnostic) => {
    if (!snapshot.ready || snapshot.busy) return;
    enter2D();
    showLayer("intersections");
    const wall = state.plan.walls.find((item) => diagnostic.wallIds.includes(item.id));
    dispatch({ type: "select", id: wall?.id ?? null });
    setConnectionFocus({
      plan: state.plan,
      point: diagnostic.point,
      request: ++connectionFocusRequest.current,
    });
  };
  const locateOverlap = (diagnostic: WallOverlapDiagnostic) => {
    if (!snapshot.ready || snapshot.busy || workspace.getSnapshot().editor.plan !== state.plan) return;
    const current = overlapAnalysis.overlaps.find((item) => item.id === diagnostic.id);
    const wall = current && state.plan.walls.find((item) => current.wallIds.includes(item.id));
    if (!current || !wall) return;
    enter2D();
    dispatch({ type: "select", id: wall.id });
    setConnectionFocus({
      plan: state.plan,
      point: current.point,
      request: ++connectionFocusRequest.current,
    });
  };
  const locateDoorCollision = (diagnostic: DoorWallCollision) => {
    if (!snapshot.ready || snapshot.busy || workspace.getSnapshot().editor.plan !== state.plan) return;
    const current = doorCollisionAnalysis.collisions.find((item) => item.id === diagnostic.id);
    if (!current) return;
    enter2D();
    setSidebar("structure");
    showLayer("doorCollisions");
    dispatch({ type: "select", id: current.doorId });
    setConnectionFocus({
      plan: state.plan,
      point: current.point,
      request: ++connectionFocusRequest.current,
    });
  };
  const locateDoorPair = (diagnostic: DoorPairCollision) => {
    if (!snapshot.ready || snapshot.busy || workspace.getSnapshot().editor.plan !== state.plan) return;
    const current = doorPairAnalysis.collisions.find((item) => item.id === diagnostic.id);
    if (!current) return;
    const firstDoor = state.plan.openings.find((opening) =>
      opening.kind === "door" && current.doorIds.includes(opening.id));
    if (!firstDoor) return;
    enter2D();
    setSidebar("structure");
    showLayer("doorCollisions");
    dispatch({ type: "select", id: firstDoor.id });
    setConnectionFocus({
      plan: state.plan,
      point: current.point,
      request: ++connectionFocusRequest.current,
    });
  };
  const locatePlanDiagnostic = (item: PlanDiagnosticItem) => {
    if (!snapshot.ready || snapshot.busy || workspace.getSnapshot().editor.plan !== state.plan) return;
    const current = planDiagnostics.items.find((candidate) => candidate.id === item.id && candidate.kind === item.kind);
    if (!current) return;
    setPlanCheckOpen(false);
    setSidebar("structure");
    switch (current.kind) {
      case "connections": locateConnection(current.diagnostic); break;
      case "intersections": locateIntersection(current.diagnostic); break;
      case "overlaps": locateOverlap(current.diagnostic); break;
      case "door-wall": locateDoorCollision(current.diagnostic); break;
      case "door-pair": locateDoorPair(current.diagnostic); break;
    }
  };
  const create3DExample = async () => {
    if (
      await workspace.importProject(serializePlan(createSpatialExamplePlan()))
    ) {
      setSidebar("structure");
      enter3D();
    }
  };
  const createRulesExample = async () => {
    setXrayOpen(false);
    if (await workspace.importProject(serializePlan(createRulesExamplePlan()))) {
      setSidebar("structure");
      enter2D();
      fit();
      setXrayOpen(true);
    }
  };
  /** Saves a proposal that exists only on a screen, and leaves every screen for the plan. */
  const saveProposal = (plan: FloorPlan, label: string) => {
    setProof(null);
    setVariantsOpen(false);
    setXrayOpen(false);
    void workspace.createGeneratedVariant(plan, label).then((saved) => {
      if (saved) {
        setSidebar("rooms");
        enter2D();
        fit();
      }
    });
  };
  const askAboutWall = (wallId: string) => {
    const asked = planAskingToRemove(state.plan, wallId, new Date().toISOString());
    const number = state.plan.walls.findIndex((wall) => wall.id === wallId) + 1;
    if (asked) setProof({ plan: asked, question: tr`Что, если убрать стену ${number}`, label: tr`без стены ${number}` });
  };
  const createVariantsExample = async () => {
    setVariantsOpen(false);
    if (await workspace.importProject(serializePlan(createVariantsExamplePlan()))) {
      setSidebar("structure");
      enter2D();
      fit();
      setVariantsOpen(true);
    }
  };
  const createWallRoomExample = async () => {
    const example: FloorPlan = {
      ...createSpatialExamplePlan(),
      name: tr`Квартира · контуры помещений`,
      roomMode: "walls",
    };
    if (await workspace.importProject(serializePlan(example))) {
      setSidebar("rooms");
      enter2D();
      fit();
    }
  };
  const wallMode = state.plan.roomMode === "walls";
  const detection = useMemo(
    () => detectViewRooms(state.plan),
    [state.plan],
  );
  const wallRooms = detection.rooms;
  const displayedRooms = wallMode ? wallRooms : state.plan.rooms;
  const selectedWallRoom = wallRooms.find(
    (room) => room.id === state.selectedId,
  );
  const adjacency = useMemo(
    () => (wallMode ? findRoomAdjacency(wallRooms, state.plan.walls, state.plan.openings) : null),
    [wallMode, wallRooms, state.plan.walls, state.plan.openings],
  );
  const selectedNeighbours = roomNeighbours(selectedWallRoom, wallRooms, adjacency);
  const requirementResults = useMemo(
    () => evaluateRequirements(state.plan, wallRooms, adjacency),
    [state.plan, wallRooms, adjacency],
  );
  const ruleReport = useMemo(() => rulesForPlan(state.plan), [state.plan]);
  const flaggedRoomIds = useMemo(() => {
    const byRules = (ruleReport?.findings ?? [])
      .filter((finding) => finding.state === "problem")
      .flatMap((finding) => finding.roomIds ?? []);
    return [...new Set([...violatingRoomIds(requirementResults), ...byRules])];
  }, [requirementResults, ruleReport]);
  const requirementConflicts = useMemo(
    () => findRequirementConflicts(state.plan.requirements),
    [state.plan.requirements],
  );
  const selectedExteriorDoors = selectedWallRoom && adjacency
    ? adjacency.exteriorDoors.filter((item) => item.roomId === selectedWallRoom.id).length
    : 0;
  const editableRectangle = selectedWallRoom ? getRectangularRoomWalls(state.plan, selectedWallRoom) : null;
  const selectRoomAt = (x: number, y: number) => {
    const room = detectViewRooms(workspace.getSnapshot().editor.plan).rooms.find((item) => Math.abs(item.bounds.minX - x) < 1e-8 && Math.abs(item.bounds.minY - y) < 1e-8);
    if (room) dispatch({ type: "select", id: room.id });
  };
  const createRectangle = (input: RectangularWallRoomInput) => {
    dispatch({ type: "wall-room:add", input, wallIds: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] });
    if (workspace.getSnapshot().editor.error) return;
    setNewRectangle(false);
    setSidebar("rooms");
    enter2D();
    selectRoomAt(input.x, input.y);
    fit();
  };
  const selected =
    !wallMode && state.plan.rooms.find((room) => room.id === state.selectedId);
  const selectedWall = state.plan.walls.find(
    (wall) => wall.id === state.selectedId,
  );
  const selectedOpening = state.plan.openings.find(
    (opening) => opening.id === state.selectedId,
  );
  const totalArea = wallMode
    ? wallRooms.filter((room) => countsInTotal(room.kind)).reduce((sum, room) => sum + room.area, 0)
    : getTotalArea(state.plan);
  // A wall end resting on another wall is joined, not a finding worth moving the list for.
  const planProblems = planDiagnostics.items.filter(
    (item) => !(item.kind === "connections" && item.diagnostic.kind === "junction"),
  ).length;
  const scenario = useMemo(
    () => scenarioSteps({
      plan: state.plan,
      freeEnds: connectionDiagnostics.filter((item) => item.kind !== "junction").length,
      violatedRequirements: requirementResults.filter((result) => result.status === "violated").length,
      variants: snapshot.projects.filter((project) => project.plan.origin?.planId === state.plan.id).length,
      rules: ruleReport,
    }),
    [state.plan, connectionDiagnostics, requirementResults, snapshot.projects, ruleReport],
  );
  const openScenarioStep = (id: ScenarioStepId) => {
    if (id === "drawing") setSidebar("source");
    else if (id === "walls" || id === "kinds") setSidebar("structure");
    else if (id === "requirements") {
      setSidebar("rooms");
      // After the tab is shown: the panel lives further down the list.
      requestAnimationFrame(() => document.querySelector(".requirements-panel")?.scrollIntoView({ block: "start" }));
    } else if (id === "norms") setXrayOpen(true);
    else if (id === "variants") setVariantsOpen(true);
    else setReportOpen(true);
  };
  const changeRoomMode = (mode: "manual" | "walls") => {
    dispatch({ type: "roomMode:set", mode });
    setTool("select");
    setSidebar("rooms");
    fit();
  };
  const changeZoom = useCallback((value: number) => setZoom(value), []);
  const fit = useCallback(() => {
    setConnectionFocus(null);
    setFitViewKey((value) => value + 1);
  }, []);
  const reportImageError = useCallback(
    (message: string) => workspace.reportNotice(message),
    [workspace],
  );
  const applyUnderlay = (underlay: Underlay, expectedPlan: FloorPlan, calibrate = true): boolean => {
    const current = workspace.getSnapshot();
    if (
      !current.ready ||
      current.busy ||
      current.editor.plan !== expectedPlan
    ) {
      workspace.reportNotice(
        tr`План изменился во время загрузки. Выберите исходный файл ещё раз.`,
      );
      return false;
    }
    dispatch({ type: "underlay:set", underlay });
    const updated = workspace.getSnapshot().editor;
    if (!updated.error && updated.plan.underlay?.dataUrl === underlay.dataUrl) {
      dispatch({ type: "select", id: null });
      setSidebar("source");
      enter2D(calibrate ? "calibrate" : "select");
      fit();
      return true;
    }
    return false;
  };
  const suggestWalls = () => {
    const underlay = state.plan.underlay;
    if (!underlay || !activePdfLines || !snapshot.ready || snapshot.busy) return;
    // Page fractions → underlay pixels → plan metres, with the current calibration.
    const width = underlay.pixelWidth * underlay.metersPerPixel;
    const height = underlay.pixelHeight * underlay.metersPerPixel;
    const toPlan = (point: Point): Point => ({ x: underlay.x + point.x * width, y: underlay.y + point.y * height });
    const segments = activePdfLines.segments.map((segment) => ({ start: toPlan(segment.start), end: toPlan(segment.end) }));
    const result = findWallCandidates(segments, state.plan.walls);
    setWallSuggestion({ plan: state.plan, ...result, selected: result.candidates.map(() => true) });
    enter2D();
  };
  const suggestOpenings = () => {
    const underlay = state.plan.underlay;
    if (!underlay || !activePdfLines || !snapshot.ready || snapshot.busy) return;
    const width = underlay.pixelWidth * underlay.metersPerPixel;
    const height = underlay.pixelHeight * underlay.metersPerPixel;
    const toPlan = (point: Point): Point => ({ x: underlay.x + point.x * width, y: underlay.y + point.y * height });
    const segments = activePdfLines.segments.map((segment) => ({ start: toPlan(segment.start), end: toPlan(segment.end) }));
    const curves = activePdfLines.curves.map((curve) => ({ points: curve.points.map(toPlan) }));
    const result = findOpeningCandidates(segments, curves, state.plan.walls, state.plan.openings);
    setOpeningSuggestion({
      plan: state.plan,
      candidates: result.candidates,
      kinds: result.candidates.map((candidate) => candidate.kind),
      selected: result.candidates.map((candidate) => candidate.confidence === "high"),
      truncated: result.truncated,
    });
    enter2D();
  };
  const acceptOpenings = () => {
    if (!activeOpeningSuggestion || !snapshot.ready || snapshot.busy) return;
    const walls: Wall[] = [];
    const openings: Opening[] = [];
    activeOpeningSuggestion.candidates.forEach((candidate, index) => {
      if (!activeOpeningSuggestion.selected[index]) return;
      let wallId = candidate.wallId;
      if (candidate.fill) {
        // A short wall closes the gap between two walls, so rooms stay closed.
        wallId = crypto.randomUUID();
        walls.push({ id: wallId, start: candidate.fill.start, end: candidate.fill.end, thickness: candidate.fill.thickness, height: candidate.fill.height });
      }
      if (wallId) openings.push(openingFromCandidate(candidate, crypto.randomUUID(), wallId, activeOpeningSuggestion.kinds[index]));
    });
    if (!openings.length) return;
    dispatch({ type: "openings:add-many", walls, openings });
    if (!workspace.getSnapshot().editor.error) setOpeningSuggestion(null);
  };
  const acceptWalls = () => {
    if (!activeSuggestion || !snapshot.ready || snapshot.busy) return;
    const chosen = activeSuggestion.candidates.filter((_, index) => activeSuggestion.selected[index]);
    if (!chosen.length) return;
    dispatch({
      type: "wall:add-many",
      walls: chosen.map((candidate) => ({
        id: crypto.randomUUID(),
        start: candidate.start,
        end: candidate.end,
        thickness: candidate.thickness,
        height: 2.7,
      })),
    });
    if (!workspace.getSnapshot().editor.error) setWallSuggestion(null);
  };
  const uploadUnderlay = async (file: File) => {
    if (imageBusy || activePdfImport || activeDxfImport || !snapshot.ready || snapshot.busy)
      return;
    const expectedPlan = workspace.getSnapshot().editor.plan;
    const generation = ++uploadGeneration.current;
    workspace.dismissNotice();
    if (/\.dxf$/i.test(file.name)) {
      setHelpOpen(false);
      setViewOpen(false);
      setDxfImport({ file, plan: expectedPlan, generation });
      return;
    }
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      setHelpOpen(false);
      setViewOpen(false);
      setPdfImport({ file, plan: expectedPlan, generation });
      return;
    }
    setImageBusy(true);
    try {
      const underlay = await readUnderlayImage(file);
      if (uploadGeneration.current !== generation) return;
      applyUnderlay(underlay, expectedPlan);
    } catch (error) {
      if (uploadGeneration.current === generation)
        workspace.reportNotice(
          error instanceof Error
            ? error.message
            : tr`Не удалось загрузить изображение.`,
        );
    } finally {
      if (uploadGeneration.current === generation) setImageBusy(false);
    }
  };
  const placeOpening = (
    wallId: string,
    offset: number,
    kind: "door" | "window",
  ) => {
    const wall = state.plan.walls.find((item) => item.id === wallId);
    if (!wall) return;
    const length = wallLength(wall.start, wall.end);
    const width = kind === "door" ? 0.9 : 1.2;
    if (length < width) {
      workspace.reportNotice(
        tr`Для этого проёма нужна стена длиной от ${formatLength(width)} м.`,
      );
      return;
    }
    dispatch({
      type: "opening:add",
      opening: {
        id: crypto.randomUUID(),
        wallId,
        kind,
        offset: Math.min(
          length - width,
          Math.max(0, Math.round((offset - width / 2) * 10) / 10),
        ),
        width,
        height: kind === "door" ? 2.1 : 1.2,
        sillHeight: kind === "door" ? 0 : 0.9,
        ...(kind === "door" ? { door: { ...DEFAULT_DOOR_SWING } } : {}),
      },
    });
    setSidebar("structure");
  };
  const updateRoom = (room: Room) => dispatch({ type: "update", room });
  const selectFromList = (id: string) => {
    dispatch({ type: "select", id });
    setTool("select");
  };
  const addDefaultRoom = () => {
    if (wallMode) dispatch({ type: "roomMode:set", mode: "manual" });
    dispatch({
      type: "add",
      room: createDefaultRoom(state.plan, crypto.randomUUID()),
    });
    setTool("select");
    fit();
  };
  const statusLabel = {
    loading: tr`Загрузка…`,
    saving: tr`Сохранение…`,
    saved: tr`Сохранено в браузере`,
    error: tr`Не сохранено`,
    conflict: tr`Конфликт версий`,
  }[snapshot.status];
  const exportProject = () => {
    try {
      const blob = new Blob([serializePlan(state.plan)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = makeExportFilename(state.plan.name);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      workspace.reportNotice(
        error instanceof Error
          ? error.message
          : tr`Не удалось экспортировать проект.`,
      );
    }
  };
  const importProject = async (file: File | undefined) => {
    if (!file || importBusy) return;
    setImportBusy(true);
    setLibraryOpen(false);
    try {
      if (file.size > MAX_PLAN_FILE_BYTES)
        throw new Error(tr`Файл слишком большой. Максимальный размер — 4 МБ.`);
      if (await workspace.importProject(await file.text())) {
        enter2D();
        fit();
      }
    } catch (error) {
      workspace.reportNotice(
        error instanceof Error ? error.message : tr`Не удалось прочитать файл.`,
      );
    } finally {
      setImportBusy(false);
      if (importRef.current) importRef.current.value = "";
    }
  };

  useEditorShortcuts({
    blocked:
      newProject ||
      newRectangle ||
      libraryOpen ||
      Boolean(calibration) ||
      Boolean(activePdfImport) ||
      Boolean(activeExport) ||
      planCheckOpen ||
      !snapshot.ready ||
      snapshot.busy,
    selectedId: state.selectedId,
    wallRoomSelected: Boolean(selectedWallRoom),
    wallMode,
    viewMode,
    dispatch,
    reportNotice: workspace.reportNotice,
    enter2D,
    setTool,
    fit,
    closePopovers,
  });

  return (
    <main className="app-shell">
      <header className="app-header">
        <Link className="brand" href="/" aria-label={tr`SpacePlan AI — главная`}>
          <span className="brand-symbol">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 20V4h16v16H4Zm0-7h9V4m0 9h7m-7 0v7"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path d="M4 4 20 20" stroke="currentColor" strokeOpacity=".28" />
            </svg>
          </span>
          <span>
            SpacePlan<span className="brand-ai">AI</span>
          </span>
        </Link>
        <span className="header-divider" />
        <div className="project-title">
          <h1 title={state.plan.name}>{state.plan.name}</h1>
          {state.plan.origin && <span className="project-tag">{tr`Вариант`}</span>}
        </div>
        <div className="header-actions">
          <span
            className={`local-status save-status-${snapshot.status}`}
            role="status"
            data-testid="save-status"
          >
            <i /> {statusLabel}
          </span>
          <button
            ref={libraryButtonRef}
            className="header-project-button"
            aria-label={tr`Мои проекты`}
            disabled={!snapshot.ready || snapshot.busy}
            onClick={() => {
              workspace.dismissNotice();
              setLibraryOpen(true);
            }}
          >
            <FolderOpen size={16} />
            <span>{tr`Мои проекты`}</span>
          </button>
          <div className="file-actions">
            <button
              className="icon-button"
              title={tr`Импортировать JSON`}
              aria-label={tr`Импорт JSON`}
              disabled={!snapshot.ready || snapshot.busy || importBusy}
              onClick={() => importRef.current?.click()}
            >
              <Upload size={16} />
            </button>
            <button
              className="icon-button export-button"
              title={tr`Скачать проект в JSON`}
              aria-label={tr`Экспорт JSON`}
              disabled={!snapshot.ready}
              onClick={exportProject}
            >
              <Download size={16} />
            </button>
          </div>
          <button
            ref={exportButtonRef}
            className="plan-export-trigger"
            title={tr`Скачать план в PNG или PDF`}
            aria-label={tr`Экспорт плана`}
            disabled={!snapshot.ready || snapshot.busy}
            onClick={() => setExportPlan(state.plan)}
          >
            <FileImage size={16} />
            <span>{tr`Экспорт плана`}</span>
          </button>
          <button
            className="secondary-button"
            disabled={!snapshot.ready || snapshot.busy}
            onClick={() => {
              workspace.dismissNotice();
              setNewProject(true);
            }}
          >
            <Plus size={16} />{tr` Новый проект`}</button>
        </div>
      </header>
      {snapshot.ready && startedAsExample(state.plan) && (
        <WelcomeStrip onExample={() => void createRulesExample()} onUpload={() => setSidebar("source")} />
      )}
      <section className="project-header">
        <ScenarioRail steps={scenario} onOpen={openScenarioStep} />
        <div className="project-header-right">
          <div className="project-variant-actions">
            <button
              className="secondary-button"
              disabled={!snapshot.ready || snapshot.busy}
              title={tr`Сохранить копию текущего плана как отдельный проект и открыть её`}
              onClick={() => {
                workspace.dismissNotice();
                void workspace.createVariant();
              }}
            >
              <GitBranch size={15} />{tr` Вариант`}</button>
            <button
              className="secondary-button"
              disabled={!snapshot.ready}
              title={tr`Сравнить текущий план с другим проектом из библиотеки`}
              onClick={() => setCompareOpen(true)}
            >
              <GitCompare size={15} />{tr` Сравнить`}</button>
            <button
              className="secondary-button"
              disabled={!snapshot.ready}
              title={tr`Что в этой квартире можно изменить и что для этого понадобится`}
              onClick={() => setXrayOpen(true)}
            >
              <ScanSearch size={15} /> X-Ray
            </button>
            <button
              className="primary-button"
              disabled={!snapshot.ready}
              title={tr`Что можно сказать о плане, насколько это надёжно и где нужен специалист`}
              onClick={() => setReportOpen(true)}
            >
              <FileCheck2 size={15} />{tr` Отчёт`}</button>
          </div>
          <button
            className={`icon-button help-button ${helpOpen ? "active" : ""}`}
            aria-label={tr`Справка по редактору`}
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen(!helpOpen)}
          >
            <CircleHelp size={18} />
          </button>
        </div>
      </section>
      {snapshot.storageError && (
        <div className="storage-notice" role="alert">
          <p>{snapshot.storageError}</p>
          <div className="storage-notice-actions">
            <button onClick={exportProject}>{tr`Экспорт JSON`}</button>
            {snapshot.status === "conflict" ? (
              <>
                <button
                  disabled={snapshot.busy}
                  onClick={async () => {
                    if (await workspace.saveCopy()) fit();
                  }}
                >{tr`Сохранить копию`}</button>
                <button
                  disabled={snapshot.busy}
                  onClick={async () => {
                    if (
                      window.confirm(
                        tr`Загрузить сохранённую версию? Текущие изменения и неприменённые поля будут заменены. Для их сохранения сначала экспортируйте JSON или сохраните копию.`,
                      )
                    ) {
                      if (await workspace.reloadSaved()) fit();
                    }
                  }}
                >{tr`Загрузить сохранённый`}</button>
              </>
            ) : (
              <button onClick={workspace.retrySave}>{tr`Повторить сохранение`}</button>
            )}
          </div>
        </div>
      )}
      <div className="editor-frame">
        <aside className="rooms-panel">
          <div className="panel-heading">
            <span>
              <Layers2 size={16} />{tr` Структура плана`}</span>
          </div>
          <div
            className="structure-tabs"
            role="tablist"
            aria-label={tr`Разделы плана`}
          >
            <button
              role="tab"
              aria-selected={sidebar === "rooms"}
              aria-controls="rooms-tab-panel"
              id="rooms-tab"
              onClick={() => setSidebar("rooms")}
            >{tr`Комнаты`}</button>
            <button
              role="tab"
              aria-selected={sidebar === "structure"}
              aria-controls="structure-tab-panel"
              id="structure-tab"
              onClick={() => setSidebar("structure")}
            >{tr`Стены`}</button>
            <button
              role="tab"
              aria-selected={sidebar === "source"}
              aria-controls="source-tab-panel"
              id="source-tab"
              onClick={() => setSidebar("source")}
            >{tr`Подложка`}</button>
          </div>
          {sidebar === "source" && (
            <div
              className="sidebar-content"
              role="tabpanel"
              id="source-tab-panel"
              aria-labelledby="source-tab"
            >
              <UnderlayPanel
                underlay={state.plan.underlay}
                busy={imageBusy || snapshot.busy || Boolean(activePdfImport)}
                onUpload={(file) => {
                  void uploadUnderlay(file);
                }}
                onChange={(underlay) => {
                  dispatch({ type: "underlay:set", underlay });
                  if (!underlay || !underlay.visible) setTool("select");
                }}
                onCalibrate={() => {
                  dispatch({ type: "select", id: null });
                  enter2D("calibrate");
                  fit();
                }}
                onMove={() => enter2D("underlay")}
              >
                {activePdfLines && state.plan.underlay && (
                  <PdfWallSuggestions
                    lineCount={activePdfLines.segments.length}
                    linesTruncated={activePdfLines.truncated}
                    calibrated={state.plan.underlay.calibrated}
                    busy={!snapshot.ready || snapshot.busy}
                    suggestion={activeSuggestion ? {
                      walls: activeSuggestion.candidates.map((candidate, index) => ({
                        length: Math.hypot(candidate.end.x - candidate.start.x, candidate.end.y - candidate.start.y),
                        thickness: candidate.thickness,
                        selected: activeSuggestion.selected[index],
                      })),
                      truncated: activeSuggestion.truncated,
                    } : null}
                    onSuggest={suggestWalls}
                    onToggle={toggleCandidate}
                    onSelectAll={(value) => setWallSuggestion((current) => current && { ...current, selected: current.selected.map(() => value) })}
                    onAccept={acceptWalls}
                    onDismiss={() => setWallSuggestion(null)}
                  />
                )}
                {activePdfLines && state.plan.underlay && (
                  <PdfOpeningSuggestions
                    calibrated={state.plan.underlay.calibrated}
                    wallCount={state.plan.walls.length}
                    busy={!snapshot.ready || snapshot.busy}
                    suggestion={activeOpeningSuggestion ? {
                      openings: activeOpeningSuggestion.candidates.map((candidate, index) => ({
                        kind: activeOpeningSuggestion.kinds[index],
                        confidence: candidate.confidence,
                        width: candidate.width,
                        place: candidate.wallId
                          ? tr`в стене ${state.plan.walls.findIndex((wall) => wall.id === candidate.wallId) + 1}`
                          : tr`между двумя стенами: добавится короткая стена`,
                        reasons: candidate.reasons,
                        selected: activeOpeningSuggestion.selected[index],
                      })),
                      truncated: activeOpeningSuggestion.truncated,
                    } : null}
                    onSuggest={suggestOpenings}
                    onToggle={toggleOpeningCandidate}
                    onKind={(index, kind) => setOpeningSuggestion((current) => current && {
                      ...current,
                      kinds: current.kinds.map((value, at) => (at === index ? kind : value)),
                    })}
                    onSelectAll={(value) => setOpeningSuggestion((current) => current && { ...current, selected: current.selected.map(() => value) })}
                    onAccept={acceptOpenings}
                    onDismiss={() => setOpeningSuggestion(null)}
                  />
                )}
              </UnderlayPanel>
            </div>
          )}
          {sidebar === "structure" && (
            <div
              className={`sidebar-content construction-list${planProblems > 0 ? " has-diagnostics" : ""}`}
              role="tabpanel"
              id="structure-tab-panel"
              aria-labelledby="structure-tab"
            >
              <div className="construction-list-heading">
                <span>{tr`СТЕНЫ И ПРОЁМЫ`}</span>
                <span data-testid="wall-count">
                  {pluralRu(state.plan.walls.length, tr`стена`, tr`стены`, tr`стен`)}
                </span>
              </div>
              <button
                className="add-room-button"
                onClick={() => enter2D("wall")}
              >
                <Plus size={14} />{tr` Начертить стену`}</button>
              {!state.plan.walls.length && (
                <p className="structure-empty">{tr`Потяните на плане от начала стены к её концу. Соседние концы притягиваются друг к другу.`}</p>
              )}
              {state.plan.openings.some((opening) => opening.kind === "door") && (
                <DoorCollisionsPanel
                  key={`door-collisions:${state.plan.id}`}
                  walls={state.plan.walls}
                  openings={state.plan.openings}
                  collisions={doorCollisionAnalysis.collisions}
                  truncated={doorCollisionAnalysis.truncated}
                  onLocate={locateDoorCollision}
                  doorPairs={doorPairAnalysis.collisions}
                  pairsTruncated={doorPairAnalysis.truncated}
                  onLocatePair={locateDoorPair}
                  busy={snapshot.busy || !snapshot.ready}
                />
              )}
              {state.plan.walls.length > 1 && (
                <WallIntersectionsPanel
                  key={`intersections:${state.plan.id}`}
                  walls={state.plan.walls}
                  intersections={intersectionAnalysis.intersections}
                  truncated={intersectionAnalysis.truncated}
                  onLocate={locateIntersection}
                  onConnect={(diagnostic) => {
                    if (!snapshot.ready || snapshot.busy) return;
                    dispatch({
                      type: "wall:connect-intersection",
                      diagnostic,
                      newWallIds: [crypto.randomUUID(), crypto.randomUUID()],
                    });
                  }}
                  error={state.error}
                  busy={snapshot.busy || !snapshot.ready}
                />
              )}
              {state.plan.walls.length > 0 && (
                <WallConnectionsPanel
                  key={`connections:${state.plan.id}`}
                  walls={state.plan.walls}
                  diagnostics={connectionDiagnostics}
                  onLocate={locateConnection}
                  onConnect={(diagnostic) => {
                    if (!snapshot.ready || snapshot.busy) return;
                    dispatch({ type: "wall:connect-endpoints", diagnostic });
                  }}
                  onCreateJunction={(diagnostic) => {
                    if (!snapshot.ready || snapshot.busy) return;
                    dispatch({
                      type: "wall:connect-junction",
                      diagnostic,
                      newWallId: crypto.randomUUID(),
                    });
                  }}
                  error={state.error}
                  busy={snapshot.busy || !snapshot.ready}
                />
              )}
              <div className="wall-listing">
                <WallKindSummary
                  walls={state.plan.walls}
                  selectedId={state.selectedId}
                  onSelect={selectFromList}
                />
                <WallList
                  walls={state.plan.walls}
                  openings={state.plan.openings}
                  selectedId={state.selectedId}
                  busy={!snapshot.ready || snapshot.busy}
                  onSelect={selectFromList}
                  onSetKind={(wallId, kind) => dispatch({ type: "wall:set-kind", wallId, kind })}
                />
              </div>
              <p className="structure-empty">{tr`Включите «По стенам» во вкладке «Комнаты»: замкнутые стены определят внутренние контуры и площадь помещений.`}</p>
            </div>
          )}
          <div
            role="tabpanel"
            id="rooms-tab-panel"
            aria-labelledby="rooms-tab"
            className="rooms-tab-content"
            hidden={sidebar !== "rooms"}
          >
            <div
              className="room-source-switch"
              role="group"
              aria-label={tr`Источник помещений`}
            >
              <button
                aria-label={tr`Ручные комнаты`}
                aria-pressed={!wallMode}
                disabled={!snapshot.ready || snapshot.busy}
                onClick={() => changeRoomMode("manual")}
              >{tr`Вручную`}</button>
              <button
                aria-label={tr`Комнаты по стенам`}
                aria-pressed={wallMode}
                disabled={!snapshot.ready || snapshot.busy}
                onClick={() => changeRoomMode("walls")}
              >{tr`По стенам`}</button>
            </div>
            <div className="rooms-section-heading">
              <span>{tr`ПОМЕЩЕНИЯ`}</span>
              <span data-testid="room-count">
                {displayedRooms.length.toString().padStart(2, "0")}
              </span>
            </div>
            <div className="room-list" aria-label={tr`Помещения`}>
              <RoomList
                rooms={displayedRooms}
                selectedId={state.selectedId}
                wallMode={wallMode}
                onSelect={selectFromList}
              />
              {wallMode && (
                <UnassignedRoomLabels
                  key={`unassigned:${state.plan.id}`}
                  labels={detection.unassigned}
                  selectedRoom={selectedWallRoom}
                  busy={snapshot.busy || !snapshot.ready}
                  error={state.error}
                  onAssign={(labelId) => {
                    if (selectedWallRoom && snapshot.ready && !snapshot.busy) {
                      dispatch({ type: "wall-room:label-assign", room: selectedWallRoom, labelId });
                    }
                  }}
                  onRemove={(labelId) => {
                    if (snapshot.ready && !snapshot.busy) dispatch({ type: "wall-room:label-remove", labelId });
                  }}
                />
              )}
              {wallMode && detection.unresolved && (
                <UnresolvedRoomsNotice
                  reason={detection.unresolved}
                  wallCount={state.plan.walls.length}
                  labelCount={state.plan.wallRoomLabels.length}
                  busy={!snapshot.ready || snapshot.busy}
                  onUseManualRooms={() => changeRoomMode("manual")}
                />
              )}
              {wallMode && (
                <div className="wall-rooms-explanation">{tr`Площадь внутри стен, с учётом их толщины. Двери и окна сохраняют границы комнат.`}{detection.warnings.map((warning, index) => (
                    <p role="status" key={index}>
                      {warning}
                    </p>
                  ))}
                  {!displayedRooms.length && (
                    <button
                      className="text-button"
                      disabled={snapshot.busy}
                      onClick={() => {
                        void createWallRoomExample();
                      }}
                    >{tr`Открыть пример со стенами `}<ArrowUpRight size={13} />
                    </button>
                  )}
                </div>
              )}
              <RequirementsPanel
                requirements={state.plan.requirements}
                results={requirementResults}
                conflicts={requirementConflicts}
                walls={state.plan.walls}
                namedRooms={wallRooms.flatMap((room) => room.labelId ? [{ labelId: room.labelId, name: room.name, kind: room.kind }] : [])}
                roomName={(id) => wallRooms.find((room) => room.id === id)?.name ?? id}
                busy={!snapshot.ready || snapshot.busy}
                onAdd={(requirement) => dispatch({ type: "requirement:add", requirement })}
                onRemove={(id) => dispatch({ type: "requirement:remove", id })}
              />
            </div>
            <button className="add-room-button" disabled={!snapshot.ready || snapshot.busy} onClick={() => { dispatch({ type: "clearError" }); setNewRectangle(true); }}>
              <BrickWall size={15} />{tr` Комната со стенами`}</button>
            {wallMode ? (
              <button
                className="add-room-button"
                onClick={() => {
                  setSidebar("structure");
                  enter2D("wall");
                }}
              >
                <BrickWall size={15} />{tr` Начать обводку стен`}</button>
            ) : (
              <button className="add-room-button" onClick={addDefaultRoom}>
                <Plus size={15} />{tr` Добавить комнату`}</button>
            )}
          </div>
          <PlanSummary rooms={displayedRooms} totalArea={totalArea} wallMode={wallMode} />
        </aside>
        <section className="workspace" aria-label={tr`Рабочая область редактора`}>
          <div className="workspace-toolbar">
            <WallKindLegend walls={state.plan.walls} />
            <div
              className="view-mode-switch"
              role="group"
              aria-label={tr`Режим просмотра`}
            >
              <button
                aria-label={tr`Режим 2D`}
                aria-pressed={viewMode === "2d"}
                onClick={() => enter2D()}
              >
                <Grid2X2 size={14} /> 2D
              </button>
              <button
                aria-label={tr`Режим 3D`}
                aria-pressed={viewMode === "3d"}
                onClick={enter3D}
              >
                <Box size={14} /> 3D
              </button>
            </div>
            <div className="history-buttons">
              <button
                ref={planCheckButtonRef}
                className="icon-button plan-check-trigger"
                aria-label={tr`Проверить план`}
                aria-haspopup="dialog"
                aria-expanded={planCheckOpen}
                title={tr`Проверка плана`}
                disabled={!snapshot.ready || snapshot.busy}
                onClick={() => {
                  setViewOpen(false);
                  setHelpOpen(false);
                  setPlanCheckOpen(true);
                }}
              >
                <ClipboardCheck size={17} />
                <span className={`plan-check-trigger-badge${planDiagnostics.total === 0 && !planDiagnostics.incomplete ? " is-clear" : ""}`} data-testid="plan-check-count" aria-hidden="true">
                  {planDiagnostics.total}{planDiagnostics.incomplete ? "+" : ""}
                </span>
              </button>
              <button
                className="icon-button"
                title={tr`Отменить (Ctrl+Z)`}
                aria-label={tr`Отменить`}
                disabled={!state.past.length}
                onClick={() => dispatch({ type: "undo" })}
              >
                <Undo2 size={17} />
              </button>
              <button
                className="icon-button"
                title={tr`Повторить (Ctrl+Shift+Z)`}
                aria-label={tr`Повторить`}
                disabled={!state.future.length}
                onClick={() => dispatch({ type: "redo" })}
              >
                <Redo2 size={17} />
              </button>
              {viewMode === "2d" && (
                <>
                  <span className="toolbar-divider" />
                  <div className="view-menu-wrap">
                    <button
                      className={`icon-button ${viewOpen ? "active" : ""}`}
                      title={tr`Настройки вида`}
                      aria-label={tr`Настройки вида`}
                      aria-expanded={viewOpen}
                      onClick={() => setViewOpen(!viewOpen)}
                    >
                      <Grid2X2 size={16} />
                    </button>
                    {viewOpen && <ViewMenu layers={layers} onChange={showLayer} />}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="canvas-area">
            {viewMode === "3d" ? (
              <PlanThree
                key={state.plan.id}
                plan={state.plan}
                wallRooms={wallRooms}
                selectedId={state.selectedId}
                onSelect={(id) => dispatch({ type: "select", id })}
                onReturnTo2D={() => enter2D()}
                onCreateExample={() => {
                  void create3DExample();
                }}
                exampleBusy={snapshot.busy}
              />
            ) : (
              <>
                <PlanCanvas
                  key={state.plan.id}
                  rooms={wallMode ? [] : state.plan.rooms}
                  wallRooms={wallRooms}
                  flaggedRoomIds={flaggedRoomIds}
                  openingCandidates={activeOpeningSuggestion?.candidates.map((candidate, index) => ({
                    from: candidate.from,
                    to: candidate.to,
                    thickness: candidate.thickness,
                    kind: activeOpeningSuggestion.kinds[index],
                    confident: candidate.confidence === "high",
                  }))}
                  openingCandidateSelection={activeOpeningSuggestion?.selected}
                  onToggleOpeningCandidate={activeOpeningSuggestion ? toggleOpeningCandidate : undefined}
                  wallCandidates={activeSuggestion?.candidates}
                  wallCandidateSelection={activeSuggestion?.selected}
                  onToggleWallCandidate={activeSuggestion ? toggleCandidate : undefined}
                  walls={state.plan.walls}
                  openings={state.plan.openings}
                  underlay={state.plan.underlay}
                  selectedRoomId={state.selectedId}
                  tool={tool}
                  zoom={zoom}
                  showGrid={layers.grid}
                  showDimensions={layers.dimensions}
                  connectionDiagnostics={connectionDiagnostics}
                  showConnections={layers.connections}
                  intersections={intersectionAnalysis.intersections}
                  showIntersections={layers.intersections}
                  doorCollisions={doorCollisionAnalysis.collisions}
                  doorPairCollisions={doorPairAnalysis.collisions}
                  showDoorCollisions={layers.doorCollisions}
                  focusConnection={connectionFocus?.plan === state.plan ? connectionFocus : undefined}
                  fitViewKey={fitViewKey}
                  onSelect={(id) => dispatch({ type: "select", id })}
                  onZoomChange={changeZoom}
                  onMoveWallNode={(wallId, endpoint, point, expectedPoint) =>
                    dispatch({ type: "wall:node-move", wallId, endpoint, point, expectedPoint })
                  }
                  keepDirections={keepDirections}
                  onMoveWall={(wallId, delta, expected) =>
                    dispatch({ type: "wall:move", wallId, delta, expected })
                  }
                  onOffsetWall={(wallId, distance, expected) =>
                    dispatch({ type: "wall:offset", wallId, distance, expected })
                  }
                  onCreateWall={(start, end) => {
                    dispatch({
                      type: "wall:add",
                      wall: {
                        id: crypto.randomUUID(),
                        start,
                        end,
                        thickness: 0.2,
                        height: 2.7,
                      },
                    });
                    setSidebar("structure");
                  }}
                  onPlaceOpening={placeOpening}
                  onCalibration={(start, end) => {
                    if (!state.plan.underlay) return;
                    setCalibrationError(null);
                    setCalibration({
                      start,
                      end,
                      underlay: state.plan.underlay,
                      projectId: state.plan.id,
                    });
                    setTool("select");
                  }}
                  onMoveUnderlay={(x, y) => {
                    if (state.plan.underlay)
                      dispatch({
                        type: "underlay:set",
                        underlay: { ...state.plan.underlay, x, y },
                      });
                  }}
                  onImageError={reportImageError}
                  onCreateRoom={(rect) => {
                    dispatch({
                      type: "add",
                      room: {
                        ...createDefaultRoom(state.plan, crypto.randomUUID()),
                        ...rect,
                      },
                    });
                  }}
                  onMoveRoom={(id, x, y) => {
                    const room = state.plan.rooms.find(
                      (item) => item.id === id,
                    );
                    if (room) updateRoom({ ...room, x, y });
                  }}
                />
                <DrawingTools
                  tool={tool}
                  hasWalls={state.plan.walls.length > 0}
                  onTool={setTool}
                  onRoomTool={() => {
                    if (wallMode) changeRoomMode("manual");
                    setTool("room");
                  }}
                />
                {!displayedRooms.length &&
                  !state.plan.walls.length &&
                  !state.plan.underlay &&
                  tool === "select" && (
                    <CanvasEmpty
                      onAddRoom={addDefaultRoom}
                      onUpload={() => setSidebar("source")}
                      onExample={async () => {
                        if (await workspace.createExample()) fit();
                      }}
                    />
                  )}
                <CanvasBottom zoom={zoom} onZoom={setZoom} onFit={fit} />
              </>
            )}
            {state.error && (
              <div role="alert" className="editor-alert">
                <span>{state.error}</span>
                <button
                  className="icon-button"
                  aria-label={tr`Скрыть ошибку`}
                  onClick={() => dispatch({ type: "clearError" })}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {viewMode === "2d" && <ToolInstruction tool={tool} />}
            {helpOpen && <HelpCard onClose={() => setHelpOpen(false)} />}
          </div>
          <div className="workspace-hint">
            <span>
              <MousePointer2 size={12} />
              {workspaceHint(viewMode, tool, Boolean(selectedWall))}
            </span>
            <span>
              <Focus size={12} />{" "}
              {viewMode === "3d" ? tr`Размеры в метрах` : tr`Привязка 0,1 м`}
            </span>
          </div>
        </section>
        <aside className="properties-panel">
          {selectedWall || selectedOpening ? (
            <ConstructionProperties
              key={JSON.stringify(selectedWall ?? selectedOpening)}
              wall={selectedWall}
              opening={selectedOpening}
              walls={state.plan.walls}
              onUpdateWall={(wall, connectEndpoints = true) => dispatch({ type: "wall:update", wall, connectEndpoints })}
              onSetWallKind={(wallId, kind) => dispatch({ type: "wall:set-kind", wallId, kind })}
              onMoveWall={(wallId, delta) => dispatch({ type: "wall:move", wallId, delta })}
              onOffsetWall={(wallId, distance) => dispatch({ type: "wall:offset", wallId, distance })}
              keepDirections={keepDirections}
              onKeepDirectionsChange={setKeepDirections}
              onUpdateOpening={(opening) =>
                dispatch({ type: "opening:update", opening })
              }
              onDelete={() => {
                if (state.selectedId)
                  dispatch({ type: "delete", id: state.selectedId });
              }}
              error={state.error}
            />
          ) : selectedWallRoom ? (
            <WallRoomProperties
              key={JSON.stringify([selectedWallRoom.id, selectedWallRoom.labelId, selectedWallRoom.name, selectedWallRoom.kind, selectedWallRoom.color, editableRectangle?.width ?? null, editableRectangle?.depth ?? null])}
              room={selectedWallRoom}
              neighbours={selectedNeighbours}
              exteriorDoors={selectedExteriorDoors}
              onSelectRoom={(id) => dispatch({ type: "select", id })}
              editableRectangle={editableRectangle}
              error={state.error}
              busy={snapshot.busy || !snapshot.ready}
              onSaveLabel={(values) => {
                if (!snapshot.ready || snapshot.busy) return;
                dispatch({
                  type: "wall-room:label-set",
                  room: selectedWallRoom,
                  values,
                  labelId: selectedWallRoom.labelId ?? crypto.randomUUID(),
                });
              }}
              onResetLabel={() => {
                if (snapshot.ready && !snapshot.busy && selectedWallRoom.labelId) {
                  dispatch({ type: "wall-room:label-remove", labelId: selectedWallRoom.labelId });
                }
              }}
              onResize={(width, depth) =>
                dispatch({ type: "wall-room:resize", room: selectedWallRoom, width, depth })
              }
              onEditWalls={() => {
                setSidebar("structure");
                enter2D();
                dispatch({ type: "select", id: null });
              }}
            />
          ) : selected ? (
            <RoomProperties
              key={`${selected.id}-${selected.name}-${selected.width}-${selected.height}-${selected.x}-${selected.y}-${selected.color}-${selected.kind}`}
              room={selected}
              onUpdate={updateRoom}
              onDelete={() => dispatch({ type: "delete", id: selected.id })}
            />
          ) : (
            <NothingSelected />
          )}
        </aside>
      </div>
      <footer className="app-footer">
        <span>
          <button
            type="button"
            className="language-switch"
            data-testid="language-switch"
            onClick={() => void workspace.flush().then(() => chooseLanguage(currentLanguage() === "en" ? "ru" : "en"))}
          >
            {currentLanguage() === "en" ? untranslated("Русский") : "English"}
          </button>
          <span className="footer-dot">·</span>
          {tr`Решения о конструктиве принимает специалист`}
        </span>
        <span>{tr`Локально в браузере · Резервная копия — JSON`}{" "}
          <span className="footer-dot">·</span>{" "}
          <span className="footer-version">{tr`Версия `}{APP_VERSION} <ArrowDownRight size={11} />
          </span>
        </span>
      </footer>
      {variantsOpen && (
        <PlanVariantsDialog
          plan={state.plan}
          onSave={(variant, index) => saveProposal(variant.plan, tr`подбор ${index}`)}
          onProof={(variant, index) => setProof({
            plan: { ...variant.plan, origin: createPlanOrigin(state.plan, new Date().toISOString()) },
            question: variant.title,
            label: tr`подбор ${index}`,
          })}
          onCompare={() => {
            setVariantsOpen(false);
            setCompareOpen(true);
          }}
          onOpenExample={() => void createVariantsExample()}
          onClose={() => setVariantsOpen(false)}
        />
      )}
      {xrayOpen && (
        <PlanXrayDialog
          plan={state.plan}
          onFacts={(facts) => dispatch({ type: "facts:set", facts })}
          onProfile={(profile) => dispatch({ type: "profile:set", profile })}
          onShow={(id) => {
            const structural = [...state.plan.walls, ...state.plan.openings].some((item) => item.id === id);
            setXrayOpen(false);
            setSidebar(structural ? "structure" : "rooms");
            enter2D();
            dispatch({ type: "select", id });
          }}
          onOpenExample={() => void createRulesExample()}
          onGenerate={() => {
            setXrayOpen(false);
            setVariantsOpen(true);
          }}
          onProofPlan={() => setProof({ plan: state.plan })}
          onProofWall={askAboutWall}
          onClose={() => setXrayOpen(false)}
        />
      )}
      {reportOpen && (
        <PlanReportDialog
          plan={state.plan}
          appVersion={APP_VERSION}
          {...(state.plan.origin ? { onProof: () => setProof({ plan: state.plan }) } : {})}
          onClose={() => setReportOpen(false)}
        />
      )}
      {proof && (
        <PlanProofDialog
          plan={proof.plan}
          appVersion={APP_VERSION}
          {...(proof.question ? { question: proof.question } : {})}
          {...(proof.label ? { onSave: () => saveProposal(proof.plan, proof.label as string) } : {})}
          onClose={() => setProof(null)}
        />
      )}
      {compareOpen && (
        <PlanCompareDialog
          current={state.plan}
          candidates={snapshot.projects.filter((project) => project.plan.id !== state.plan.id)}
          onClose={() => setCompareOpen(false)}
        />
      )}
      {planCheckOpen && (
        <PlanCheckDialog
          planName={state.plan.name}
          walls={state.plan.walls}
          openings={state.plan.openings}
          report={planDiagnostics}
          busy={snapshot.busy || !snapshot.ready}
          onLocate={locatePlanDiagnostic}
          onClose={() => {
            setPlanCheckOpen(false);
            planCheckButtonRef.current?.focus();
          }}
        />
      )}
      {activeExport && (
        <PlanExportDialog
          plan={activeExport}
          isCurrent={() => workspace.getSnapshot().editor.plan === activeExport}
          onClose={() => {
            setExportPlan(null);
            exportButtonRef.current?.focus();
          }}
        />
      )}
      {activePdfImport && (
        <PdfImportDialog
          file={activePdfImport.file}
          onClose={() => {
            uploadGeneration.current += 1;
            setPdfImport(null);
          }}
          onApply={(underlay, lines) => {
            if (uploadGeneration.current !== activePdfImport.generation) return;
            const applied = applyUnderlay(underlay, activePdfImport.plan);
            setWallSuggestion(null);
            setPdfLines(applied && lines ? { dataUrl: underlay.dataUrl, lines } : null);
            uploadGeneration.current += 1;
            setPdfImport(null);
          }}
        />
      )}
      {activeDxfImport && (
        <DxfImportDialog
          file={activeDxfImport.file}
          onClose={() => {
            uploadGeneration.current += 1;
            setDxfImport(null);
          }}
          onApply={(underlay, lines) => {
            if (uploadGeneration.current !== activeDxfImport.generation) return;
            // The scale comes from the file's units, so no calibration step follows.
            const applied = applyUnderlay(underlay, activeDxfImport.plan, false);
            setWallSuggestion(null);
            setOpeningSuggestion(null);
            setPdfLines(applied ? { dataUrl: underlay.dataUrl, lines } : null);
            uploadGeneration.current += 1;
            setDxfImport(null);
          }}
        />
      )}
      {calibration && (
        <CalibrationDialog
          start={calibration.start}
          end={calibration.end}
          underlay={calibration.underlay}
          error={calibrationError}
          onClose={() => {
            setCalibration(null);
            setCalibrationError(null);
          }}
          onApply={(knownMeters) => {
            try {
              const current = workspace.getSnapshot().editor.plan;
              if (
                current.id !== calibration.projectId ||
                current.underlay !== calibration.underlay
              )
                throw new Error(tr`Подложка изменилась. Выберите точки заново.`);
              const underlay = calibrateUnderlay(
                calibration.underlay,
                calibration.start,
                calibration.end,
                knownMeters,
              );
              dispatch({ type: "underlay:set", underlay });
              const error = workspace.getSnapshot().editor.error;
              if (error) throw new Error(error);
              setCalibration(null);
              setCalibrationError(null);
              fit();
            } catch (error) {
              setCalibrationError(
                error instanceof Error
                  ? error.message
                  : tr`Проверьте длину отрезка.`,
              );
            }
          }}
        />
      )}
      {newRectangle && (
        <RectangularRoomDialog
          x={state.plan.walls.length ? Math.max(...state.plan.walls.flatMap((wall) => [wall.start.x + wall.thickness / 2, wall.end.x + wall.thickness / 2])) + 1 : 0}
          error={state.error}
          busy={snapshot.busy || !snapshot.ready}
          onClose={() => setNewRectangle(false)}
          onCreate={createRectangle}
        />
      )}
      {newProject && (
        <NewProjectDialog
          onClose={() => setNewProject(false)}
          error={snapshot.notice}
          busy={snapshot.busy}
          onCreate={async (name) => {
            if (await workspace.createProject(name)) {
              setNewProject(false);
              enter2D();
              fit();
            }
          }}
        />
      )}
      {libraryOpen && (
        <ProjectsDialog
          projects={snapshot.projects}
          trash={snapshot.trash}
          currentId={state.plan.id}
          unreadableCount={snapshot.unreadableCount}
          notice={snapshot.notice}
          busy={snapshot.busy}
          onClose={() => {
            setLibraryOpen(false);
            libraryButtonRef.current?.focus();
          }}
          onNew={() => {
            setLibraryOpen(false);
            setNewProject(true);
            workspace.dismissNotice();
          }}
          onImport={() => importRef.current?.click()}
          onSaveUnreadable={() => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(workspace.unreadableRecords(), null, 2)], { type: "application/json" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = tr`SpacePlan-нечитаемые-записи.json`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
          }}
          onRename={workspace.renameProject}
          onRestore={workspace.restoreProject}
          onTrash={async (id, expectedRevision) => {
            const previousId = workspace.getSnapshot().editor.plan.id;
            const success = await workspace.trashProject(id, expectedRevision);
            if (success && workspace.getSnapshot().editor.plan.id !== previousId) {
              enter2D();
              fit();
            }
            return success;
          }}
          onOpen={async (id) => {
            if (await workspace.openProject(id)) {
              fit();
              enter2D();
              setLibraryOpen(false);
            }
          }}
        />
      )}
      <input
        ref={importRef}
        className="project-file-input"
        type="file"
        accept=".json,application/json"
        aria-label={tr`Файл проекта JSON`}
        onChange={(event) => {
          void importProject(event.target.files?.[0]);
        }}
      />
      {snapshot.notice && !newProject && !libraryOpen && (
        <div
          className="storage-toast"
          role="alert"
          data-testid="project-notice"
        >
          <span>{snapshot.notice}</span>
          <button
            className="icon-button"
            aria-label={tr`Закрыть сообщение`}
            onClick={workspace.dismissNotice}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {!snapshot.ready && (
        <div className="workspace-loading" role="status">{tr`Восстанавливаем ваши проекты…`}</div>
      )}
    </main>
  );
}
