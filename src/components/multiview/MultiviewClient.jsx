"use client";

import { useMemo, useState, useEffect } from "react";
import { LAYOUTS, pickLayout } from "@/lib/layouts";
import GamedayWidget from "@/components/gameday/GamedayWidget";
import EventInfo from "@/components/gameday/navbar/EventInfo";
import EventLocalTime from "@/components/gameday/navbar/EventLocalTime";

export default function MultiviewClient({
  parentEvent,
  teams = [],
  divisionKeys = [],
    divisions = [],
}) {
  // ==============================
  // DATA
  // ==============================
  const parentKey = parentEvent?.key;
  const frames = parentKey
    ? [...divisionKeys, parentKey]
    : divisionKeys;

  // ==============================
  // LAYOUT STATE
  // ==============================
  const [manualOverride, setManualOverride] = useState(false);
  const [selectedLayout, setSelectedLayout] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const autoLayout = pickLayout(frames.length);
  const layoutKey = manualOverride ? selectedLayout : autoLayout;
  const layout = LAYOUTS[layoutKey];
  const capacity = layout.slots.length;

  // ==============================
  // CORE STATE (CLEAN MODEL)
  // ==============================

  // ordering (source of truth)
  const [priorityOrder, setPriorityOrder] = useState(frames);

  // visibility
  const [enabled, setEnabled] = useState(() => {
    const map = {};
    frames.forEach(f => (map[f] = true));
    return map;
  });

  // ==============================
  // DERIVED STATE
  // ==============================

  // visible + ordered + capped
  const visibleFrames = useMemo(() => {
    return priorityOrder
      .filter(key => enabled[key])
      .slice(0, capacity);
  }, [priorityOrder, enabled, capacity]);

  const onScreenSet = useMemo(
    () => new Set(visibleFrames),
    [visibleFrames]
  );

  // ==============================
  // ACTIONS
  // ==============================

  // move to spotlight (slot 0)
  function focusDivision(key) {
    setPriorityOrder(prev => [
      key,
      ...prev.filter(k => k !== key),
    ]);
  }

  // toggle visibility
  function toggleDivision(key) {
    setEnabled(prev => ({
      ...prev,
      [key]: !prev[key],
    }));
  }

  // reorder (sidebar)
  function movePriority(index, direction) {
    setPriorityOrder(prev => {
      const next = [...prev];

      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;

      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // layout controls
  function resetToAuto() {
    setManualOverride(false);
    setSelectedLayout(null);
  }

  function selectLayout(key) {
    setSelectedLayout(key);
    setManualOverride(true);
  }

  // ==============================
  // EMPTY STATE
  // ==============================
  if (frames.length === 0) {
    return (
      <div className="w-screen h-screen">
        <GamedayWidget
          event={parentEvent}
          team={teams[0]}
          isMultiview={false}
        />
      </div>
    );
  }

  // ==============================
  // RENDER
  // ==============================
  return (
    <div className="h-screen bg-black text-white overflow-hidden flex">

      {/* ================= MAIN ================= */}
      <div className="flex-1 flex flex-col">

        {/* ===== CONTROL BAR ===== */}
        <div className="flex justify-between items-center px-2 h-10 border-b border-neutral-800">

          {/* LEFT */}
          <div className="text-sm font-bold flex gap-2 items-center">
            <EventInfo event={parentEvent} />
            <span className="text-neutral-500">
              ({divisionKeys.length} divisions)
            </span>
            <span className="text-neutral-400">
              <EventLocalTime timezone={parentEvent.timezone} />
            </span>
          </div>

          {/* CENTER: FOCUS BUTTONS */}
          <div className="flex gap-1 flex-wrap">
            {priorityOrder.map(key => {
              const isEnabled = enabled[key];
              const isOnScreen = onScreenSet.has(key);
              const isPrimary = visibleFrames[0] === key;

              return (
                <button
                  key={key}
                  onClick={() => focusDivision(key)}
                  className={`
                    px-2 py-1 text-xs rounded transition

                    ${
                      !isEnabled
                        ? "bg-neutral-900 opacity-30"
                        : isOnScreen
                        ? "bg-neutral-700"
                        : "bg-neutral-700 opacity-50"
                    }

                    ${isPrimary ? "ring-1 ring-white" : ""}
                  `}
                >
                  {divisions.find(k => k.key === key)?.short_name || (key === parentKey ? parentEvent.name : key)}
                </button>
              );
            })}
          </div>

          {/* RIGHT */}
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
          >
            Layouts
          </button>
        </div>

        {/* ===== GRID ===== */}
        <div className="relative flex-1">

          {visibleFrames.map((frameKey, index) => {
            const slot = layout.slots[index];
            if (!slot) return null;

            return (
              <div
                key={frameKey}
                style={{
                  position: "absolute",
                  left: `${slot.x}%`,
                  top: `${slot.y}%`,
                  width: `${slot.w}%`,
                  height: `${slot.h}%`,
                }}
                className="transition-all duration-300 ease-in-out"
              >
                <GamedayWidget
                  event={frameKey}
                  team={teams[0]}
                  isMultiview={true}
                />
              </div>
            );
          })}

        </div>
      </div>

      {/* ================= SIDEBAR ================= */}
      {sidebarOpen && (
        <div className="w-64 bg-neutral-900 border-l border-neutral-700 p-3 flex flex-col gap-3">

          {/* Layouts */}
          <div className="font-bold">Layouts</div>

          <button
            onClick={resetToAuto}
            className="px-2 py-1 bg-green-600 rounded text-sm"
          >
            Auto Layout ({autoLayout})
          </button>

          <div className="h-px bg-neutral-700 my-2" />

          {Object.keys(LAYOUTS).map(key => (
            <button
              key={key}
              onClick={() => selectLayout(key)}
              className={`
                text-left px-2 py-1 rounded text-sm
                hover:bg-neutral-800
                ${layoutKey === key ? "bg-neutral-700" : ""}
              `}
            >
              {key}
            </button>
          ))}

          {/* Priority */}
          <div className="h-px bg-neutral-700 my-2" />
          <div className="font-bold text-sm">Priority Order</div>

          <div className="flex flex-col gap-1 mt-2">
            {priorityOrder.map((key, index) => (
              <div
                key={key}
                className="flex items-center justify-between px-2 py-1 bg-neutral-800 rounded text-xs"
              >
                <span>{key}</span>

                <div className="flex gap-1">
                  <button
                    onClick={() => movePriority(index, -1)}
                    className="px-1 hover:bg-neutral-700 rounded"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => movePriority(index, 1)}
                    className="px-1 hover:bg-neutral-700 rounded"
                  >
                    ↓
                  </button>
                </div>
              </div>
            ))}
          </div>

        </div>
      )}
    </div>
  );
}