import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Spherical,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { FloorPlan, Opening, Wall } from "@/domain/floor-plan/types";
import { doorSwingLocal } from "@/domain/floor-plan/door-swing";
import type { WallRoom } from "@/domain/floor-plan/wall-rooms";
import { createWallRoomFloorGeometry } from "./wall-room-floor";
import {
  buildWallSolids,
  FLOOR_THICKNESS,
  spatialBounds,
} from "@/domain/floor-plan/spatial";

export type RendererStatus = "loading" | "ready" | "error";

export interface ThreeScene {
  updatePlan: (plan: FloorPlan, wallRooms?: readonly WallRoom[]) => void;
  select: (id: string | null) => void;
  fit: () => void;
  top: () => void;
  zoom: (factor: number) => void;
  dispose: () => void;
}

interface SelectionMaterial {
  id: string;
  material: MeshStandardMaterial | LineBasicMaterial;
  color: Color;
}

/** Dispose only resources owned by this viewer; no geometry/material is shared outside it. */
function disposeObjects(root: Object3D): void {
  const materials = new Set<Material>();
  root.traverse((object) => {
    if (object instanceof Mesh || object instanceof LineSegments) {
      object.geometry.dispose();
      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      objectMaterials.forEach((material) => materials.add(material));
    }
  });
  materials.forEach((material) => material.dispose());
  root.clear();
}

export function createThreeScene(
  host: HTMLDivElement,
  onSelect: (id: string | null) => void,
  onStatus: (status: RendererStatus) => void,
): ThreeScene {
  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "default",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-label", "3D-модель планировки");
  canvas.setAttribute("role", "img");
  host.appendChild(canvas);

  const scene = new Scene();
  scene.background = new Color("#e9ece7");
  const camera = new PerspectiveCamera(42, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.015;
  controls.minPolarAngle = 0.0001;
  controls.rotateSpeed = 0.75;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.8;
  const model = new Group();
  const surroundings = new Group();
  scene.add(model, surroundings);
  const sky = new HemisphereLight("#ffffff", "#b7c0ad", 2.4);
  const sun = new DirectionalLight("#fff7e8", 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.025;
  scene.add(sky, sun, sun.target);

  let disposed = false;
  let failed = false;
  let frame = 0;
  let firstRender = true;
  let currentPlan: FloorPlan | null = null;
  let selectedId: string | null = null;
  let pickables: Mesh[] = [];
  let selectionMaterials: SelectionMaterial[] = [];
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let pointerStart: { x: number; y: number; id: number } | null = null;
  const activePointers = new Set<number>();

  const render = () => {
    frame = 0;
    if (disposed || failed) return;
    try {
      renderer.render(scene, camera);
      host.dataset.cameraPosition = camera.position
        .toArray()
        .map((value) => value.toFixed(5))
        .join(",");
      host.dataset.cameraTarget = controls.target
        .toArray()
        .map((value) => value.toFixed(5))
        .join(",");
      if (firstRender) {
        firstRender = false;
        onStatus("ready");
      }
    } catch {
      failed = true;
      onStatus("error");
    }
  };
  const requestRender = () => {
    if (!frame && !disposed && !failed) frame = requestAnimationFrame(render);
  };
  controls.addEventListener("change", requestRender);

  const resize = () => {
    if (disposed) return;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    requestRender();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  const fit = (fromTop = false) => {
    if (!currentPlan || failed) return;
    const bounds = spatialBounds(currentPlan);
    const size = new Vector3(
      Math.max(1, bounds.maxX - bounds.minX),
      Math.max(0.2, bounds.maxY - bounds.minY),
      Math.max(1, bounds.maxZ - bounds.minZ),
    );
    const center = new Vector3(
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minY + bounds.maxY) / 2,
      (bounds.minZ + bounds.maxZ) / 2,
    );
    const radius = Math.max(1.5, size.length() / 2);
    const verticalFov = (camera.fov * Math.PI) / 180;
    const horizontalFov =
      2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
    const distance =
      (radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * 1.12;
    const direction = fromTop
      ? new Vector3(0, 1, 0.0002).normalize()
      : new Vector3(1, 0.95, 1).normalize();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(0.005, distance / 10000);
    camera.far = Math.max(200, distance * 8);
    camera.updateProjectionMatrix();
    controls.minDistance = Math.max(0.15, radius * 0.04);
    controls.maxDistance = Math.max(50, radius * 30);
    controls.update();
    requestRender();
  };

  const select = (id: string | null) => {
    selectedId = id;
    for (const entry of selectionMaterials) {
      const isSelected = entry.id === id;
      if (entry.material instanceof MeshStandardMaterial) {
        entry.material.emissive.set(isSelected ? "#4d8064" : "#000000");
        entry.material.emissiveIntensity = isSelected ? 0.25 : 0;
      } else {
        entry.material.color.copy(
          isSelected ? new Color("#1f6d4c") : entry.color,
        );
        entry.material.opacity = isSelected ? 1 : 0.24;
      }
    }
    requestRender();
  };

  const box = (
    parent: Group,
    id: string,
    width: number,
    height: number,
    depth: number,
    center: Vector3,
    color: string,
    edges = true,
  ) => {
    const geometry = new BoxGeometry(width, height, depth);
    const material = new MeshStandardMaterial({
      color,
      roughness: 0.83,
      metalness: 0,
    });
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(center);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.entityId = id;
    pickables.push(mesh);
    selectionMaterials.push({ id, material, color: material.color.clone() });
    parent.add(mesh);
    if (edges) {
      const edgeMaterial = new LineBasicMaterial({
        color: "#6d776c",
        transparent: true,
        opacity: 0.24,
      });
      const outline = new LineSegments(
        new EdgesGeometry(geometry),
        edgeMaterial,
      );
      mesh.add(outline);
      selectionMaterials.push({
        id,
        material: edgeMaterial,
        color: edgeMaterial.color.clone(),
      });
    }
    return mesh;
  };

  const addOpening = (wallGroup: Group, wall: Wall, opening: Opening) => {
    const left = opening.offset;
    const middle = left + opening.width / 2;
    const bottom = opening.sillHeight;
    const frameWidth = Math.min(0.045, opening.width / 8, opening.height / 8);
    const frameDepth = Math.max(0.035, wall.thickness * 0.65);
    const frameColor = opening.kind === "window" ? "#d7e0dc" : "#baaa90";
    for (const x of [
      left + frameWidth / 2,
      left + opening.width - frameWidth / 2,
    ]) {
      box(
        wallGroup,
        opening.id,
        frameWidth,
        opening.height,
        frameDepth,
        new Vector3(x, bottom + opening.height / 2, 0),
        frameColor,
        false,
      );
    }
    box(
      wallGroup,
      opening.id,
      opening.width - 2 * frameWidth,
      frameWidth,
      frameDepth,
      new Vector3(middle, bottom + opening.height - frameWidth / 2, 0),
      frameColor,
      false,
    );
    box(
      wallGroup,
      opening.id,
      opening.width - 2 * frameWidth,
      opening.kind === "window" ? frameWidth : 0.015,
      frameDepth,
      new Vector3(
        middle,
        bottom + (opening.kind === "window" ? frameWidth / 2 : 0.0075),
        0,
      ),
      frameColor,
      false,
    );
    if (opening.kind === "window") {
      const glassMaterial = new MeshStandardMaterial({
        color: "#9cc1c5",
        transparent: true,
        opacity: 0.28,
        roughness: 0.25,
        metalness: 0.08,
        depthWrite: false,
        side: DoubleSide,
      });
      const glass = new Mesh(
        new BoxGeometry(
          opening.width - frameWidth * 2,
          opening.height - frameWidth * 2,
          0.012,
        ),
        glassMaterial,
      );
      glass.position.set(middle, bottom + opening.height / 2, 0);
      glass.userData.entityId = opening.id;
      wallGroup.add(glass);
      pickables.push(glass);
      selectionMaterials.push({
        id: opening.id,
        material: glassMaterial,
        color: glassMaterial.color.clone(),
      });
    } else {
      // Keep the opening selectable through its frame when the leaf is open.
      const hitTarget = new Mesh(
        new BoxGeometry(opening.width, opening.height, wall.thickness),
        new MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
          colorWrite: false,
        }),
      );
      hitTarget.position.set(middle, bottom + opening.height / 2, 0);
      hitTarget.userData.entityId = opening.id;
      wallGroup.add(hitTarget);
      pickables.push(hitTarget);
      const swing = doorSwingLocal(opening);
      if (swing) {
        const leaf = box(
          wallGroup,
          opening.id,
          opening.width,
          opening.height - 2 * frameWidth,
          Math.min(0.045, wall.thickness * 0.32, opening.width * 0.1),
          new Vector3(
            opening.offset + (swing.hinge.x + swing.openEnd.x) / 2,
            bottom + opening.height / 2,
            (swing.hinge.y + swing.openEnd.y) / 2,
          ),
          "#c1a77f",
        );
        leaf.rotation.y = -Math.atan2(
          swing.openEnd.y - swing.hinge.y,
          swing.openEnd.x - swing.hinge.x,
        );
      }
    }
  };

  const updatePlan = (plan: FloorPlan, wallRooms: readonly WallRoom[] = []) => {
    const shouldFit =
      currentPlan?.id !== plan.id || currentPlan?.roomMode !== plan.roomMode;
    currentPlan = plan;
    disposeObjects(model);
    disposeObjects(surroundings);
    pickables = [];
    selectionMaterials = [];
    const manualRooms = plan.roomMode === "walls" ? [] : plan.rooms;
    const detectedRooms = plan.roomMode === "walls" ? wallRooms : [];
    for (const room of detectedRooms) {
      const material = new MeshStandardMaterial({
        color: room.color,
        roughness: 0.83,
        metalness: 0,
      });
      const geometry = createWallRoomFloorGeometry(room);
      const mesh = new Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.entityId = room.id;
      pickables.push(mesh);
      selectionMaterials.push({
        id: room.id,
        material,
        color: material.color.clone(),
      });
      const edgeMaterial = new LineBasicMaterial({
        color: "#6d776c",
        transparent: true,
        opacity: 0.24,
      });
      mesh.add(new LineSegments(new EdgesGeometry(geometry), edgeMaterial));
      selectionMaterials.push({
        id: room.id,
        material: edgeMaterial,
        color: edgeMaterial.color.clone(),
      });
      model.add(mesh);
    }
    for (const room of manualRooms) {
      box(
        model,
        room.id,
        room.width,
        FLOOR_THICKNESS,
        room.height,
        new Vector3(
          room.x + room.width / 2,
          -FLOOR_THICKNESS / 2,
          room.y + room.height / 2,
        ),
        room.color,
      );
    }
    let solidCount = 0;
    for (const wall of plan.walls) {
      const wallGroup = new Group();
      wallGroup.position.set(wall.start.x, 0, wall.start.y);
      wallGroup.rotation.y = -Math.atan2(
        wall.end.y - wall.start.y,
        wall.end.x - wall.start.x,
      );
      model.add(wallGroup);
      const openings = plan.openings.filter(
        (entry) => entry.wallId === wall.id,
      );
      const solids = buildWallSolids(wall, openings);
      solidCount += solids.length;
      for (const solid of solids) {
        box(
          wallGroup,
          wall.id,
          solid.length,
          solid.height,
          solid.thickness,
          new Vector3(
            solid.offset + solid.length / 2,
            solid.bottom + solid.height / 2,
            0,
          ),
          "#eee9df",
        );
      }
      openings.forEach((opening) => addOpening(wallGroup, wall, opening));
    }
    host.dataset.wallSolids = String(solidCount);
    host.dataset.floorCount = String(manualRooms.length + detectedRooms.length);
    host.dataset.wallRoomCount = String(detectedRooms.length);
    host.dataset.openingCount = String(plan.openings.length);
    host.dataset.doorLeafCount = String(
      plan.openings.filter((opening) => opening.kind === "door").length,
    );
    const bounds = spatialBounds(plan);
    host.dataset.modelHeight = String(bounds.maxY);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const span = Math.max(
      8,
      bounds.maxX - bounds.minX,
      bounds.maxZ - bounds.minZ,
      bounds.maxY,
    );
    const gridStep = span > 100 ? 10 : span > 35 ? 5 : 1;
    const divisions = Math.min(160, Math.ceil((span * 1.7) / gridStep));
    const gridSize = divisions * gridStep;
    const ground = new Mesh(
      new PlaneGeometry(gridSize * 3, gridSize * 3),
      new MeshStandardMaterial({ color: "#e9ece7", roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(centerX, -FLOOR_THICKNESS - 0.012, centerZ);
    ground.receiveShadow = true;
    surroundings.add(ground);
    const grid = new GridHelper(gridSize, divisions, "#bdc8bb", "#d0d7cc");
    grid.position.set(
      Math.round(centerX / gridStep) * gridStep,
      -FLOOR_THICKNESS - 0.01,
      Math.round(centerZ / gridStep) * gridStep,
    );
    surroundings.add(grid);
    sun.position.set(centerX + span * 0.4, span * 1.5, centerZ + span * 0.75);
    sun.target.position.set(centerX, 0, centerZ);
    sun.shadow.camera.left = -span;
    sun.shadow.camera.right = span;
    sun.shadow.camera.top = span;
    sun.shadow.camera.bottom = -span;
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far = span * 5;
    sun.shadow.camera.updateProjectionMatrix();
    camera.far = Math.max(
      camera.far,
      camera.position.distanceTo(new Vector3(centerX, 0, centerZ)) + span * 4,
    );
    camera.updateProjectionMatrix();
    if (shouldFit) fit();
    select(selectedId);
    requestRender();
  };

  const zoom = (factor: number) => {
    const offset = camera.position.clone().sub(controls.target);
    const distance = Math.min(
      controls.maxDistance,
      Math.max(controls.minDistance, offset.length() * factor),
    );
    camera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
    requestRender();
  };

  const pointerDown = (event: PointerEvent) => {
    activePointers.add(event.pointerId);
    if (activePointers.size !== 1 || event.button !== 0) {
      pointerStart = null;
      return;
    }
    host.focus({ preventScroll: true });
    pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const pointerUp = (event: PointerEvent) => {
    activePointers.delete(event.pointerId);
    const start = pointerStart;
    pointerStart = null;
    if (
      !start ||
      start.id !== event.pointerId ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 ||
      failed
    )
      return;
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    const id: unknown = hit?.object.userData.entityId;
    onSelect(typeof id === "string" ? id : null);
  };
  const pointerCancel = (event: PointerEvent) => {
    activePointers.delete(event.pointerId);
    pointerStart = null;
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || failed) return;
    const key = event.key.toLowerCase();
    if (key === "f" || key === "а") {
      event.preventDefault();
      fit();
    } else if (key === "t" || key === "е") {
      event.preventDefault();
      fit(true);
    } else if (key === "+" || key === "=" || key === "-" || key === "_") {
      event.preventDefault();
      zoom(key === "+" || key === "=" ? 0.8 : 1.25);
    } else if (key.startsWith("arrow")) {
      event.preventDefault();
      const horizontal =
        key === "arrowleft" ? -1 : key === "arrowright" ? 1 : 0;
      const vertical = key === "arrowup" ? -1 : key === "arrowdown" ? 1 : 0;
      const offset = camera.position.clone().sub(controls.target);
      if (event.shiftKey) {
        const right = new Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new Vector3().setFromMatrixColumn(camera.matrix, 1);
        const shift = right
          .multiplyScalar(horizontal * offset.length() * 0.04)
          .addScaledVector(up, -vertical * offset.length() * 0.04);
        controls.target.add(shift);
        camera.position.add(shift);
      } else {
        const spherical = new Spherical().setFromVector3(offset);
        spherical.theta += horizontal * 0.12;
        spherical.phi = Math.max(
          controls.minPolarAngle,
          Math.min(controls.maxPolarAngle, spherical.phi + vertical * 0.12),
        );
        camera.position
          .copy(controls.target)
          .add(new Vector3().setFromSpherical(spherical));
      }
      controls.update();
      requestRender();
    }
  };
  const contextLost = (event: Event) => {
    event.preventDefault();
    if (disposed) return;
    failed = true;
    cancelAnimationFrame(frame);
    frame = 0;
    onStatus("error");
  };
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerCancel);
  canvas.addEventListener("webglcontextlost", contextLost);
  host.addEventListener("keydown", keyDown);

  return {
    updatePlan,
    select,
    fit: () => fit(),
    top: () => fit(true),
    zoom,
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerCancel);
      canvas.removeEventListener("webglcontextlost", contextLost);
      host.removeEventListener("keydown", keyDown);
      controls.removeEventListener("change", requestRender);
      controls.dispose();
      disposeObjects(model);
      disposeObjects(surroundings);
      sun.shadow.map?.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      pickables = [];
      selectionMaterials = [];
    },
  };
}
