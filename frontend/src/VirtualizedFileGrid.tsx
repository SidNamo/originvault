import {
  Fragment,
  type Key,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ListingViewMode } from "./ListingControls";

const OVERSCAN_PX = 900;

const rowHeight = (viewMode: ListingViewMode) =>
  viewMode === "preview"
    ? 226
    : viewMode === "details"
      ? 55
      : 76;

const initialColumns = (viewMode: ListingViewMode) =>
  viewMode === "grid-2" ? 2 : viewMode === "grid-3" ? 3 : 1;

type VirtualRange = {
  start: number;
  end: number;
  columns: number;
  rowGap: number;
  rowHeight: number;
};

export function VirtualizedFileGrid({
  itemCount,
  viewMode,
  resetKey,
  itemKey,
  renderItem,
  inactive = false,
}: {
  itemCount: number;
  viewMode: ListingViewMode;
  resetKey: string;
  itemKey: (index: number) => Key;
  renderItem: (index: number) => ReactNode;
  inactive?: boolean;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<VirtualRange>(() => ({
    start: 0,
    end: Math.min(itemCount, 60),
    columns: initialColumns(viewMode),
    rowGap: viewMode === "details" ? 0 : 8,
    rowHeight: rowHeight(viewMode),
  }));

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const style = window.getComputedStyle(grid);
      const template = style.gridTemplateColumns.trim();
      const columns = template && template !== "none"
        ? template.split(/\s+/).length
        : 1;
      const height = rowHeight(viewMode);
      const gap = Number.parseFloat(style.rowGap) || 0;
      const stride = height + gap;
      const rowCount = Math.ceil(itemCount / columns);
      const bounds = grid.getBoundingClientRect();
      const visibleTop = Math.max(0, -bounds.top);
      const visibleBottom = Math.max(
        0,
        Math.min(bounds.height, window.innerHeight - bounds.top),
      );
      const startRow = Math.max(
        0,
        Math.floor((visibleTop - OVERSCAN_PX) / stride),
      );
      const endRow = Math.min(
        rowCount,
        Math.max(startRow + 1, Math.ceil((visibleBottom + OVERSCAN_PX) / stride)),
      );
      const next = {
        start: Math.min(itemCount, startRow * columns),
        end: Math.min(itemCount, endRow * columns),
        columns,
        rowGap: gap,
        rowHeight: height,
      };
      setRange((current) =>
        current.start === next.start &&
        current.end === next.end &&
        current.columns === next.columns &&
        current.rowGap === next.rowGap &&
        current.rowHeight === next.rowHeight
          ? current
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(schedule);
    resizeObserver?.observe(grid);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [itemCount, resetKey, viewMode]);

  const start = range.start < itemCount ? range.start : 0;
  const end = range.start < itemCount
    ? Math.min(itemCount, Math.max(start, range.end))
    : Math.min(itemCount, 60);
  const totalRows = Math.ceil(itemCount / range.columns);
  const rowsBefore = Math.floor(start / range.columns);
  const visibleRows = Math.ceil((end - start) / range.columns);
  const rowsAfter = Math.max(0, totalRows - rowsBefore - visibleRows);
  const spacerHeight = (rows: number) =>
    rows > 0
      ? rows * (range.rowHeight + range.rowGap) - range.rowGap
      : 0;
  const indexes = Array.from(
    { length: Math.max(0, end - start) },
    (_, offset) => start + offset,
  );

  return (
    <div
      ref={gridRef}
      className={`file-grid virtual-file-grid view-${viewMode} ${inactive ? "listing-inactive" : ""}`}
      inert={inactive ? true : undefined}
      aria-disabled={inactive || undefined}
    >
      {rowsBefore > 0 && (
        <div
          className="virtual-file-spacer"
          style={{ height: spacerHeight(rowsBefore) }}
          aria-hidden="true"
        />
      )}
      {indexes.map((index) => (
        <Fragment key={itemKey(index)}>{renderItem(index)}</Fragment>
      ))}
      {rowsAfter > 0 && (
        <div
          className="virtual-file-spacer"
          style={{ height: spacerHeight(rowsAfter) }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
