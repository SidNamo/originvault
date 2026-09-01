import { ArrowDown, ArrowUp, Grid2X2, Grid3X3, Images, List } from "lucide-react";

export type ListingSortField = "name" | "kind" | "size" | "originalCreated" | "originalModified";
export type ListingSortDirection = "asc" | "desc";
export type ListingViewMode = "details" | "grid-2" | "grid-3" | "preview";

export function ListingControls({
  itemCount,
  sortField,
  sortDirection,
  viewMode,
  onSortFieldChange,
  onSortDirectionChange,
  onViewModeChange,
}: {
  itemCount: number;
  sortField: ListingSortField;
  sortDirection: ListingSortDirection;
  viewMode: ListingViewMode;
  onSortFieldChange: (value: ListingSortField) => void;
  onSortDirectionChange: () => void;
  onViewModeChange: (value: ListingViewMode) => void;
}) {
  return (
    <div className="file-list-tools">
      <span>{itemCount}개 항목</span>
      <div className="sort-controls">
        <label>
          <select aria-label="정렬 기준" value={sortField} onChange={(event) => onSortFieldChange(event.target.value as ListingSortField)}>
            <option value="originalCreated">원본 생성 일시</option>
            <option value="originalModified">원본 수정 일시</option>
            <option value="name">이름</option>
            <option value="kind">종류</option>
            <option value="size">크기</option>
          </select>
        </label>
        <button className="icon-btn sort-direction" title={sortDirection === "asc" ? "오름차순" : "내림차순"} aria-label={sortDirection === "asc" ? "오름차순 정렬" : "내림차순 정렬"} onClick={onSortDirectionChange}>
          {sortDirection === "asc" ? <ArrowUp /> : <ArrowDown />}
        </button>
      </div>
      <div className="view-mode-buttons" role="group" aria-label="보기 방식">
        {([
          ["details", List, "자세히"],
          ["grid-2", Grid2X2, "2열"],
          ["grid-3", Grid3X3, "3열"],
          ["preview", Images, "미리보기"],
        ] as const).map(([mode, Icon, label]) => (
          <button key={mode} className={viewMode === mode ? "active" : ""} title={`${label} 보기`} aria-label={`${label} 보기`} aria-pressed={viewMode === mode} onClick={() => onViewModeChange(mode)}><Icon /></button>
        ))}
      </div>
    </div>
  );
}
