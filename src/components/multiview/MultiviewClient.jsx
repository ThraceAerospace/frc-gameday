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
  // LABELS
  // ==============================
  const [labels, setLabels] = useState({});

  function registerLabel(index, label) {
    setLabels((prev) => {
      if (prev[index] === label) return prev;
      return { ...prev, [index]: label };
    });
  }

  // ==============================
  // LAYOUT
  // ==============================
  const [manualOverride, setManualOverride] = useState(false);
  const [selectedLayout, setSelectedLayout] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeChildIndex, setActiveChildIndex] = useState(null);

  const layoutSelectValue = childArray.length || 1;
  const autoLayout = pickLayout(layoutSelectValue);

  const layoutKey = manualOverride ? selectedLayout : autoLayout;
  const layout = LAYOUTS[layoutKey];

  // ==============================
  // STREAM PRIORITY ORDER (CORE STATE)
  // ==============================
  const [streamOrder, setStreamOrder] = useState(() =>
    childArray.map((_, i) => i)
  );

  const [homeStreamOrder, setHomeStreamOrder] = useState(() =>
    childArray.map((_, i) => i)
  );

  useEffect(() => {
    const base = childArray.map((_, i) => i);
    setStreamOrder(base);
    setHomeStreamOrder(base);
  }, [childArray.length]);

  // ==============================
  // PRIORITY CONTROLS
  // ==============================
  function moveUp(streamIndex) {
    setStreamOrder((prev) => {
      const pos = prev.indexOf(streamIndex);
      if (pos <= 0) return prev;

      const next = [...prev];
      [next[pos - 1], next[pos]] = [next[pos], next[pos - 1]];
      return next;
    });
  }

  function moveDown(streamIndex) {
    setStreamOrder((prev) => {
      const pos = prev.indexOf(streamIndex);
      if (pos === -1 || pos === prev.length - 1) return prev;

      const next = [...prev];
      [next[pos + 1], next[pos]] = [next[pos], next[pos + 1]];
      return next;
    });
  }

  function resetOrder() {
    setStreamOrder(homeStreamOrder);
  }

  // ==============================
  // SIGNAL LISTENER
  // ==============================
  useMultiviewSignal((signal) => {
    if (signal.type === "match_imminent") {
      const streamIndex = childArray.findIndex(
        (child) => child?.props?.matchKey === signal.matchKey
      );

      if (streamIndex === -1) return;

      const slotIndex = streamOrder.findIndex((i) => i === streamIndex);

      if (slotIndex !== -1) {
        const next = [...streamOrder];
        const item = next.splice(slotIndex, 1)[0];
        next.unshift(item);
        setStreamOrder(next);
      }
    }
  });

  // ==============================
  // PiP
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
        {/* TOP BAR */}
        <div className="flex justify-between items-center px-2 h-10 border-b border-neutral-800">
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
              <span className="pl-2 font-bold text-lg">FRC Gameday</span>
            )}
          </div>

          {/* STREAM SELECT BUTTONS */}
          <div className="flex gap-1">
            {childArray.map((_, childIndex) => {
              const isActive = childIndex === activeChildIndex;

              const label =
                labels[childIndex] || `Stream ${childIndex + 1}`;

              return (
                <button
                  key={childIndex}
                  onClick={() => {
                    if (isActive) {
                      setStreamOrder(homeStreamOrder);
                      setActiveChildIndex(null);
                      setManualOverride(false);
                      return;
                    }

                    setManualOverride(true);
                    setSelectedLayout(
                      pickHighlightLayout(layout.slots.length)
                    );

                    setActiveChildIndex(childIndex);

                    const pos = streamOrder.indexOf(childIndex);
                    if (pos !== -1) {
                      const next = [...streamOrder];
                      const item = next.splice(pos, 1)[0];
                      next.unshift(item);
                      setStreamOrder(next);
                    }
                  }}
                  className={`
                    px-2 py-1 text-xs rounded transition
                    bg-neutral-800 hover:bg-neutral-700
                    truncate min-w-0 max-w-50
                    ${isActive ? "ring-2 ring-white" : ""}
                  `}
                >
                  {label.replace("- FIRST Robotics Competition", "")}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded"
          >
            <Squares2X2Icon className="w-5 h-5" />
          </button>
        </div>

        {/* GRID */}
        <div className="relative flex-1">
          {layout.slots.map((slotLayout, slotIndex) => {
            const streamIndex = streamOrder[slotIndex];
            const child = childArray[streamIndex];

            if (!child) return null;

            return (
              <div
                key={child?.key ?? streamIndex}
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
                    registerLabel(streamIndex, label),
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* SIDEBAR */}
      {sidebarOpen && (
        <div className="w-64 bg-neutral-900 border-l border-neutral-700 p-3">
          <div className="font-bold">Stream Priority</div>

          <button
            onClick={resetOrder}
            className="mt-2 px-2 py-1 bg-green-600 rounded text-sm"
          >
            Reset Order
          </button>

          <div className="h-px bg-neutral-700 my-2" />

          <div className="space-y-1">
            {streamOrder.map((streamIndex, position) => {
              const label =
                labels[streamIndex] || `Stream ${streamIndex + 1}`;

              return (
                <div
                  key={streamIndex}
                  className="flex items-center justify-between bg-neutral-800 px-2 py-1 rounded"
                >
                  <span className="text-xs truncate">
                    {label.replace("- FIRST Robotics Competition", "")}
                  </span>

                  <div className="flex gap-1">
                    <button
                      onClick={() => moveUp(streamIndex)}
                      className="px-2 py-0.5 bg-neutral-700 rounded text-xs"
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveDown(streamIndex)}
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

          <div className="font-bold text-sm">Layouts</div>

          <button
            onClick={() => {
              setManualOverride(false);
              setSelectedLayout(null);
            }}
            className="px-2 py-1 bg-green-600 rounded text-sm mt-2"
          >
            Auto Layout ({LAYOUTS[autoLayout].name})
          </button>

          <div className="h-px bg-neutral-700 my-2" />

          {Object.entries(LAYOUTS).map(([key, value]) => (
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
              {value.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}