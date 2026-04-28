"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { LAYOUTS, pickLayout, pickHighlightLayout } from "@/lib/layouts";
import React from "react";
import EventLocalTime from "../gameday/navbar/EventLocalTime";
import EventInfo from "../gameday/navbar/EventInfo";
import { useRouter } from "next/navigation";
import { HomeIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import { createRoot } from "react-dom/client";

// ==============================
// SIGNAL BUS
// ==============================
const listeners = new Set();

export function emitMultiviewSignal(signal) {
  listeners.forEach((l) => l(signal));
}

function useMultiviewSignal(handler) {
  const stableHandler = useCallback(handler, []);

  useEffect(() => {
    listeners.add(stableHandler);
    return () => listeners.delete(stableHandler);
  }, [stableHandler]);
}

// ==============================
// COMPONENT
// ==============================
export default function MultiviewClient({
  isDivisional,
  parentEvent,
  children = [],
}) {
  const router = useRouter();

  const childArray = useMemo(
    () => React.Children.toArray(children),
    [children]
  );

  // ==============================
  // LABEL SYSTEM (UNCHANGED)
  // ==============================
  const [labels, setLabels] = useState({});

  function registerLabel(index, label) {
    setLabels((prev) => {
      if (prev[index] === label) return prev;
      return { ...prev, [index]: label };
    });
  }

  // ==============================
  // LAYOUT STATE (UNCHANGED LOGIC)
  // ==============================
  const [selectedLayout, setSelectedLayout] = useState(null);
  const [baseLayout, setBaseLayout] = useState(null);
  const [activeChildIndex, setActiveChildIndex] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const layoutSelectValue = childArray.length || 1;
  const autoLayout = pickLayout(layoutSelectValue);

  const layoutKey = selectedLayout ?? autoLayout;
  const layout = LAYOUTS[layoutKey];

  // ==============================
  // HOME ORDER (UNCHANGED)
  // ==============================
  const [homeOrder, setHomeOrder] = useState(() =>
    childArray.map((_, i) => i)
  );

  useEffect(() => {
    setHomeOrder(childArray.map((_, i) => i));
  }, [childArray.length]);

  // ==============================
  // SLOT ORDER (UNCHANGED LOGIC)
  // ==============================
  const slotOrder = useMemo(() => {
    if (activeChildIndex == null) return homeOrder;

    const next = [...homeOrder];
    const index = next.indexOf(activeChildIndex);

    if (index > -1) {
      next.splice(index, 1);
      next.unshift(activeChildIndex);
    }

    return next;
  }, [activeChildIndex, homeOrder]);

  const visibleKeys = useMemo(() => {
    return slotOrder.slice(0, layout.slots.length);
  }, [slotOrder, layout.slots.length]);

  const isOffScreen = (childIndex) => {
    return !visibleKeys.includes(childIndex);
  };

  // ==============================
  // SIGNAL LISTENER (UNCHANGED)
  // ==============================
  useMultiviewSignal((signal) => {
    if (signal.type === "match_imminent") {
      const childIndex = childArray.findIndex(
        (child) => child?.props?.matchKey === signal.matchKey
      );

      if (childIndex === -1) return;

      setActiveChildIndex(childIndex);

      setBaseLayout(selectedLayout ?? autoLayout);
      setSelectedLayout(pickHighlightLayout(childArray.length));
    }
  });

  // ==============================
  // PiP (UNCHANGED)
  // ==============================
  const [pipWindow, setPipWindow] = useState(null);
  const pipContainerRef = useRef(null);

  useEffect(() => {
    if (!pipWindow || !pipContainerRef.current) return;

    if (!pipContainerRef.current._root) {
      pipContainerRef.current._root = createRoot(pipContainerRef.current);
    }

    const activeChild =
      activeChildIndex != null
        ? React.cloneElement(childArray[activeChildIndex])
        : React.cloneElement(childArray[0]);

    pipContainerRef.current._root.render(activeChild);
  }, [pipWindow, activeChildIndex, childArray]);

  // ==============================
  // RENDER
  // ==============================
  return (
    <div className="h-screen bg-black text-white overflow-hidden flex">
      <div className="flex-1 flex flex-col">

        {/* =========================
            TOP BAR (RESTORED UI)
        ========================== */}
        <div className="flex justify-between items-center px-2 h-10 border-b border-neutral-800">

          {/* LEFT */}
          <div className="flex items-center">
            <button
              onClick={() => router.push("/")}
              className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded"
            >
              <HomeIcon className="w-4 h-5" />
            </button>

            {isDivisional && parentEvent ? (
              <div className="flex flex-col pl-2">
                <span className="font-bold text-sm">
                  <EventInfo event={parentEvent} />
                </span>
                <span className="text-xs text-gray-400">
                  <EventLocalTime timezone={parentEvent.timezone} />
                </span>
              </div>
            ) : (
              <div className="flex flex-col pl-2">
                <span className="font-bold text-sm">
                  FieldView
                </span>
                <span className="text-xs text-gray-400">
                  Powered by The Blue Alliance
                </span>
              </div>
            )}
          </div>

          {/* CENTER: STREAM BUTTONS (FIXED VISUAL STATE ONLY) */}
          <div className="flex gap-1">
            {homeOrder.map((childIndex) => {
              const isActive = childIndex === activeChildIndex;
              const layoutCount = layout.slots.length;
              const isDimmed = isOffScreen(childIndex);
              const label =
                labels[childIndex] || `Stream ${childIndex + 1}`;

              return (
                <button
                  key={childIndex}
                  onClick={() => {
                    const isSame = childIndex === activeChildIndex;

                    if (isSame) {
                      setActiveChildIndex(null);

                      if (baseLayout) {
                        setSelectedLayout(baseLayout);
                        setBaseLayout(null);
                      } else {
                        setSelectedLayout(null);
                      }
                      return;
                    }

                    setActiveChildIndex(childIndex);
                    setBaseLayout(selectedLayout ?? autoLayout);
                    setSelectedLayout(
                      pickHighlightLayout(isDimmed ? layout.slots.length + 1 : layout.slots.length)
                    );
                  }}
                  className={`
                    px-2 py-1 text-xs rounded transition
                    hover:bg-neutral-700
                    truncate
                    ${isActive ? "ring-2 ring-white" : ""}
                    ${isDimmed ? "opacity-60 bg-gray-800" : "opacity-100 bg-neutral-800"}
                  `}
                >
                  {label.replace("- FIRST Robotics Competition", "")}
                </button>
              );
            })}
          </div>

          {/* RIGHT */}
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded"
          >
            <Squares2X2Icon className="w-5 h-5" />
          </button>
        </div>

        {/* =========================
            GRID (UNCHANGED LOGIC)
        ========================== */}
        <div className="relative flex-1">
          {childArray.map((child, childIndex) => {
            const slotIndex = slotOrder.findIndex(i => i === childIndex);
            const slotLayout = layout.slots[slotIndex];

            if (!slotLayout) return null;

            return (
              <div
                key={child?.key ?? childIndex}
                style={{
                  position: "absolute",
                  left: `${slotLayout.x}%`,
                  top: `${slotLayout.y}%`,
                  width: `${slotLayout.w}%`,
                  height: `${slotLayout.h}%`,
                  transition: "all 300ms ease",
                }}
              >
                {React.cloneElement(child, {
                  registerLabel: (label) =>
                    registerLabel(childIndex, label),
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* =========================
          SIDEBAR OVERLAY
      ========================= */}
      <>
        {/* BACKDROP */}
        <div
          onClick={() => setSidebarOpen(false)}
          className={`
            fixed inset-0 bg-black/50 z-40
            transition-opacity duration-300
            ${sidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}
          `}
        />

        {/* SIDEBAR PANEL */}
        <div
          className={`
            fixed top-0 right-0 h-full
            w-[clamp(260px,25vw,400px)]
            bg-neutral-900 border-l border-neutral-700 p-3
            z-50 shadow-xl
            transition-transform duration-300
            ${sidebarOpen ? "translate-x-0" : "translate-x-full"}
          `}
        >
          <div className="font-bold text-sm mb-2">Stream Priority</div>

          <div className="space-y-1">
            {homeOrder.map((childIndex) => {
              const label =
                labels?.[childIndex] || `Stream ${childIndex + 1}`;

              return (
                <div
                  key={childIndex}
                  className="flex items-center justify-between bg-neutral-800 px-2 py-1 rounded"
                >
                  {/* LABEL */}
                  <span className="text-xs truncate">
                    {label.replace("- FIRST Robotics Competition", "")}
                  </span>

                  {/* CONTROLS */}
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        setHomeOrder((prev) => {
                          const i = prev.indexOf(childIndex);
                          if (i <= 0) return prev;
                          const next = [...prev];
                          [next[i - 1], next[i]] = [next[i], next[i - 1]];
                          return next;
                        });
                      }}
                      className="px-2 py-0.5 bg-neutral-700 rounded text-xs"
                    >
                      ↑
                    </button>

                    <button
                      onClick={() => {
                        setHomeOrder((prev) => {
                          const i = prev.indexOf(childIndex);
                          if (i === -1 || i === prev.length - 1) return prev;
                          const next = [...prev];
                          [next[i + 1], next[i]] = [next[i], next[i + 1]];
                          return next;
                        });
                      }}
                      className="px-2 py-0.5 bg-neutral-700 rounded text-xs"
                    >
                      ↓
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="h-px bg-neutral-700 my-2" />

          <div className="font-bold pb-1">Layouts</div>

          {Object.entries(LAYOUTS).map(([key, value]) => (
            <button
              key={key}
              onClick={() => setSelectedLayout(key)}
              className={`
                block w-full text-left px-2 py-1 rounded text-sm
                hover:bg-neutral-800
                ${layoutKey === key ? "bg-neutral-700" : ""}
              `}
            >
              {value.name}
            </button>
          ))}
        </div>
      </>
    </div>
  );
}