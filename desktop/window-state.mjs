import { readFileSync, writeFileSync } from "node:fs";

/** Restore geometry only when it still intersects a connected display. */
export function restoreWindowState(value, displays) {
  const fallback = { width: 1280, height: 860, maximized: false };
  if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite)) return fallback;
  if (value.width < 640 || value.height < 480 || value.width > 10000 || value.height > 10000) return fallback;
  const visible = displays.some(
    ({ workArea: area }) =>
      value.x + value.width >= area.x + 100 &&
      value.x <= area.x + area.width - 100 &&
      value.y >= area.y &&
      value.y <= area.y + area.height - 100,
  );
  return visible
    ? { x: value.x, y: value.y, width: value.width, height: value.height, maximized: value.maximized === true }
    : fallback;
}

export function readWindowState(path, displays) {
  try {
    return restoreWindowState(JSON.parse(readFileSync(path, "utf8")), displays);
  } catch {
    return restoreWindowState(undefined, displays);
  }
}

export function saveWindowState(path, window) {
  try {
    writeFileSync(path, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }));
  } catch (error) {
    console.warn("Could not save OCGW window position:", error.message);
  }
}
