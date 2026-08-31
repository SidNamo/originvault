import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  HardDrive,
  RefreshCw,
} from "lucide-react";
import type { Folder as VaultFolder } from "./api";

interface FolderTreeProps {
  folders: VaultFolder[];
  selectedId?: string;
  onSelect: (folder?: VaultFolder) => void;
  onRefresh: () => void;
  refreshing?: boolean;
  draggingItems?: boolean;
  onDropItems?: (folder?: VaultFolder) => void;
  onDropFiles?: (dataTransfer: DataTransfer, folder?: VaultFolder) => void;
}

export function FolderTree({
  folders,
  selectedId,
  onSelect,
  onRefresh,
  refreshing = false,
  draggingItems = false,
  onDropItems,
  onDropFiles,
}: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dropTargetId, setDropTargetId] = useState<string | null>();
  const children = useMemo(() => {
    const result = new Map<string | null, VaultFolder[]>();
    for (const folder of folders) {
      const list = result.get(folder.parentId) ?? [];
      list.push(folder);
      result.set(folder.parentId, list);
    }
    return result;
  }, [folders]);

  useEffect(() => {
    if (!selectedId) return;
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const ancestors: string[] = [];
    let current = byId.get(selectedId);
    while (current?.parentId) {
      ancestors.push(current.parentId);
      current = byId.get(current.parentId);
    }
    setExpanded((previous) => new Set([...previous, ...ancestors, selectedId]));
  }, [folders, selectedId]);
  useEffect(() => {
    if (!draggingItems) setDropTargetId(undefined);
  }, [draggingItems]);

  const allowDrop = (
    event: React.DragEvent<HTMLElement>,
    targetId: string | null,
  ) => {
    const externalFiles = event.dataTransfer.types.includes("Files");
    if (!draggingItems && !externalFiles) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = draggingItems ? "move" : "copy";
    setDropTargetId(targetId);
  };
  const leaveDrop = (
    event: React.DragEvent<HTMLElement>,
    targetId: string | null,
  ) => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setDropTargetId((current) => (current === targetId ? undefined : current));
  };
  const drop = (
    event: React.DragEvent<HTMLElement>,
    target?: VaultFolder,
  ) => {
    const externalFiles = event.dataTransfer.types.includes("Files");
    if (!draggingItems && !externalFiles) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTargetId(undefined);
    if (draggingItems) onDropItems?.(target);
    else onDropFiles?.(event.dataTransfer, target);
  };

  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const renderNodes = (
    parentId: string | null,
    depth: number,
  ): React.ReactNode =>
    (children.get(parentId) ?? []).map((folder) => {
      const hasChildren = Boolean(children.get(folder.id)?.length);
      const isExpanded = expanded.has(folder.id);
      return (
        <div key={folder.id} className="tree-branch">
          <div
            className={`tree-row ${selectedId === folder.id ? "selected" : ""} ${dropTargetId === folder.id ? "drop-target" : ""}`}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onDragOver={(event) => allowDrop(event, folder.id)}
            onDragLeave={(event) => leaveDrop(event, folder.id)}
            onDrop={(event) => drop(event, folder)}
          >
            <button
              className="tree-toggle"
              aria-label={isExpanded ? "폴더 접기" : "폴더 펼치기"}
              disabled={!hasChildren}
              onClick={() => toggle(folder.id)}
            >
              {hasChildren ? (
                isExpanded ? (
                  <ChevronDown />
                ) : (
                  <ChevronRight />
                )
              ) : (
                <span />
              )}
            </button>
            <button
              className="tree-label"
              title={folder.relativePath}
              onClick={() => {
                onSelect(folder);
                if (hasChildren)
                  setExpanded((previous) => new Set(previous).add(folder.id));
              }}
            >
              <Folder />
              <span>{folder.name}</span>
            </button>
          </div>
          {hasChildren && isExpanded && renderNodes(folder.id, depth + 1)}
        </div>
      );
    });

  return (
    <section className="folder-tree" aria-label="폴더 트리">
      <div className="tree-heading">
        <p>FOLDERS</p>
        <button
          title="폴더 목록 새로고침"
          aria-label="폴더 목록 새로고침"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? "spin" : ""} />
        </button>
      </div>
      <button
        className={`tree-root ${!selectedId ? "selected" : ""} ${dropTargetId === null ? "drop-target" : ""}`}
        onClick={() => onSelect()}
        onDragOver={(event) => allowDrop(event, null)}
        onDragLeave={(event) => leaveDrop(event, null)}
        onDrop={(event) => drop(event)}
      >
        <HardDrive />내 파일
      </button>
      <div
        className="tree-scroll"
        onDragOver={(event) => allowDrop(event, null)}
        onDragLeave={(event) => leaveDrop(event, null)}
        onDrop={(event) => drop(event)}
      >
        {renderNodes(null, 0)}
      </div>
    </section>
  );
}
