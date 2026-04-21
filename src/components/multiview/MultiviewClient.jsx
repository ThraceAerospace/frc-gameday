"use client";

import { useEffect, useMemo, useState } from "react";
import { LAYOUTS, pickLayout } from "@/lib/layouts";
import React from "react";

export default function MultiviewClient({ children = [] }) {
  // Normalize children into stable array
  const childArray = useMemo(() => React.Children.toArray(children), [children]);

  // ==============================
  // LAYOUT
  // ==============================
  const [manualOverride, setManualOverride] = useState(false);
  const [selectedLayout, setSelectedLayout] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const autoLayout = pickLayout(childArray.length || 1);
  const layoutKey = manualOverride ? selectedLayout : autoLayout;
  const layout = LAYOUTS[layoutKey];

  // ==============================
  // SLOT ORDER (stores child indices)
  // slotOrder[slotIndex] = childIndex
  // ==============================
  const [slotOrder, setSlotOrder] = useState(() =>
    layout.slots.map((_, i) => i)
  );

  // Reset slot mapping when layout changes
  useEffect(() => {
    setSlotOrder(layout.slots.map((_, i) => i));
  }, [layoutKey, childArray.length]);

  // ==============================
  // HELPERS
  // ==============================
  function swapSlots(a, b) {
    setSlotOrder(prev => {
      const next = [...prev];
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    });
  }

  function moveToPrimary(index) {
    setSlotOrder(prev => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.unshift(item);
      return next;
    });
  }

  // ==============================
  // RENDER MAP
  // ==============================
  const renderMap = useMemo(() => {
    return childArray.map((child, childIndex) => {
      const slotIndex = slotOrder.findIndex(i => i === childIndex);

      if (slotIndex === -1) return null;

      const slotLayout = layout.slots[slotIndex];

      return {
        child,
        childIndex,
        slotIndex,
        slotLayout,
      };
    });
  }, [childArray, slotOrder, layout]);

  // ==============================
  // RENDER
  // ==============================
  return (
    <div className="h-screen bg-black text-white overflow-hidden flex">

      {/* MAIN */}
      <div className="flex-1 flex flex-col">

        {/* CONTROL BAR */}
        <div className="flex justify-between items-center px-2 h-10 border-b border-neutral-800">

          <div className="text-sm font-bold">
            Multiview ({childArray.length})
          </div>

          <div className="flex gap-1 flex-wrap">
            {layout.slots.map((_, index) => (
              <button
                key={index}
                onClick={() => moveToPrimary(index)}
                className={`
                  px-2 py-1 text-xs rounded transition bg-neutral-700
                  ${index === 0 ? "ring-1 ring-white" : ""}
                `}
              >
                Slot {index + 1}
              </button>
            ))}
          </div>

          <button
            onClick={() => setSidebarOpen(v => !v)}
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
          >
            Layouts
          </button>
        </div>

        {/* GRID */}
        <div className="relative flex-1">

          {renderMap.map(({ child, childIndex, slotLayout }) => {
            if (!slotLayout) return null;

            return (
              <div
                key={childIndex}
                style={{
                  position: "absolute",
                  left: `${slotLayout.x}%`,
                  top: `${slotLayout.y}%`,
                  width: `${slotLayout.w}%`,
                  height: `${slotLayout.h}%`,
                  transition: "all 300ms ease",
                }}
              >
                {child}
              </div>
            );
          })}

        </div>
      </div>

      {/* SIDEBAR */}
      {sidebarOpen && (
        <div className="w-64 bg-neutral-900 border-l border-neutral-700 p-3">

          <div className="font-bold">Layouts</div>

          <button
            onClick={() => {
              setManualOverride(false);
              setSelectedLayout(null);
            }}
            className="px-2 py-1 bg-green-600 rounded text-sm mt-2"
          >
            Auto Layout ({autoLayout})
          </button>

          <div className="h-px bg-neutral-700 my-2" />

          {Object.keys(LAYOUTS).map(key => (
            <button
              key={key}
              onClick={() => {
                setSelectedLayout(key);
                setManualOverride(true);
              }}
              className={`
                block w-full text-left px-2 py-1 rounded text-sm
                hover:bg-neutral-800
                ${layoutKey === key ? "bg-neutral-700" : ""}
              `}
            >
              {key}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}