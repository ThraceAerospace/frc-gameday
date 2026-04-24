"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { LAYOUTS, pickLayout } from "@/lib/layouts";
import React from "react";
import EventLocalTime from "../gameday/navbar/EventLocalTime";
import EventInfo from "../gameday/navbar/EventInfo";
import { useRouter } from "next/navigation";
import { HomeIcon } from "@heroicons/react/24/outline";
import { Squares2X2Icon } from "@heroicons/react/24/outline";
import { createRoot } from "react-dom/client";

// ==============================
// SIGNAL BUS (module scope)
// ==============================
const listeners = new Set();

export function emitMultiviewSignal(signal) {
  listeners.forEach((l) => l(signal));
}

function useMultiviewSignal(handler) {
  const stableHandler = useCallback(handler, []);

  useEffect(() => {
    listeners.add(stableHandler);

    return () => {
      listeners.delete(stableHandler);
    };
  }, [stableHandler]);
}

// ==============================
// COMPONENT
// ==============================
export default function MultiviewClient({ isDivisional, parentEvent, children = [] }) {
  const router = useRouter();

  // Normalize children into stable array
  const childArray = useMemo(() => React.Children.toArray(children), [children]);

  // ==============================
  // LAYOUT
  // ==============================
  const [manualOverride, setManualOverride] = useState(false);
  const [selectedLayout, setSelectedLayout] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeChildIndex, setActiveChildIndex] = useState(null);

  const autoLayout = pickLayout(childArray.length || 1);
  const layoutKey = manualOverride ? selectedLayout : autoLayout;
  const layout = LAYOUTS[layoutKey];

  // ==============================
  // SLOT ORDER
  // ==============================
  const [slotOrder, setSlotOrder] = useState(() =>
    layout.slots.map((_, i) => i)
  );

  const [homeSlotOrder, setHomeSlotOrder] = useState(() =>
    childArray.map((_, i) => i)
  );

  useEffect(() => {
    setSlotOrder(layout.slots.map((_, i) => i));
  }, [layoutKey, childArray.length]);

  useEffect(() => {
    const base = childArray.map((_, i) => i);
    setSlotOrder(base);
    setHomeSlotOrder(base);
  }, [layoutKey]);

  // ==============================
  // SIGNAL LISTENER (SAFE)
  // ==============================
  useMultiviewSignal((signal) => {
    if (signal.type === "match_imminent") {
      const childIndex = childArray.findIndex((child) => {
        return child?.props?.matchKey === signal.matchKey;
      });

      if (childIndex === -1) return;

      const slotIndex = slotOrder.findIndex(i => i === childIndex);

      if (slotIndex !== -1) {
        moveToPrimary(slotIndex);
      }
    }
  });

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
    return layout.slots.map((_, slotIndex) => {
      const childIndex = slotOrder[slotIndex];
      const child = childArray[childIndex];
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
  // Picture In Picture Experimental Support (Document PiP)
  // ==============================
  const [pipWindow, setPipWindow] = useState(null);
  const pipContainerRef = useRef(null);
  async function openPiP() {
    if (!("documentPictureInPicture" in window)) {
      console.warn("Document PiP not supported");
      return;
    }

    if (pipWindow && !pipWindow.closed) {
      pipWindow.focus();
      return;
    }

    const pip = await window.documentPictureInPicture.requestWindow({
      width: 480,
      height: 270,
    });

    // Reset base styles
    pip.document.body.style.margin = "0";
    pip.document.body.style.background = "black";

    // ✅ Copy ALL stylesheets
    [...document.styleSheets].forEach((styleSheet) => {
      try {
        if (styleSheet.href) {
          // External stylesheet (Tailwind build, etc.)
          const link = pip.document.createElement("link");
          link.rel = "stylesheet";
          link.href = styleSheet.href;
          pip.document.head.appendChild(link);
        } else if (styleSheet.cssRules) {
          // Inline styles
          const style = pip.document.createElement("style");
          [...styleSheet.cssRules].forEach((rule) => {
            style.appendChild(
              pip.document.createTextNode(rule.cssText)
            );
          });
          pip.document.head.appendChild(style);
        }
      } catch (err) {
        // Ignore CORS-restricted stylesheets
        console.warn("Could not copy stylesheet:", err);
      }
    });
    pip.document.documentElement.className =
      document.documentElement.className;

    const container = pip.document.createElement("div");
    container.id = "pip-root";
    pip.document.body.appendChild(container);

    pipContainerRef.current = container;
    setPipWindow(pip);

    pip.addEventListener("pagehide", () => {
      setPipWindow(null);
      pipContainerRef.current = null;
    });
  }

  useEffect(() => {
    if (!pipWindow || !pipContainerRef.current) return;

    const container = pipContainerRef.current;

    // Create root once
    if (!container._root) {
      container._root = createRoot(container);
    }

    const activeChild =
      activeChildIndex != null
        ? React.cloneElement(childArray[activeChildIndex])
        : React.cloneElement(childArray[0]);

    container._root.render(
      <div style={{ width: "100vw", height: "100vh", background: "black" }}>
        {activeChild}
      </div>
    );
  }, [pipWindow, pipContainerRef, activeChildIndex, childArray]);

  // ==============================
  // RENDER
  // ==============================
  return (
    <div className="h-screen bg-black text-white overflow-hidden flex">

      {/* MAIN */}
      <div className="flex-1 flex flex-col">

        {/* CONTROL BAR */}
        <div className="flex justify-between items-center px-2 h-10 border-b border-neutral-800">

          <div className="text-sm flex">
            <button
              className="px-3 py-1 gap-2 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
              onClick={() => router.push("/")}
            >
              <HomeIcon className="w-5 h-5" />
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
            ) : <span className="gap-2 pl-2 font-bold text-lg">FRC Gameday <span className="text-xs text-gray-400 opacity-70">Powered by the Blue Alliance</span></span>}
          </div>

          <div className="flex gap-1">
            {childArray.map((child, childIndex) => {
              const isActive = childIndex === activeChildIndex;

              const label =
                child?.props?.eventName ||
                child?.props?.title ||
                child?.props?.name ||
                `Stream ${childIndex + 1}`;

              return (
                <button
                  key={childIndex}
                  onClick={() => {
                    const isActive = childIndex === activeChildIndex;

                    if (isActive) {
                      setSlotOrder(homeSlotOrder);
                      setActiveChildIndex(null);
                      return;
                    }

                    setActiveChildIndex(childIndex);

                    const slotIndex = slotOrder.findIndex(i => i === childIndex);

                    if (slotIndex !== -1) {
                      moveToPrimary(slotIndex);
                    }
                  }}
                  className={`
                    px-2 py-1 text-xs rounded transition bg-neutral-800 hover:bg-neutral-700
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
            onClick={() => setSidebarOpen(v => !v)}
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
          >
            <Squares2X2Icon className="w-5 h-5" />
          </button>
          {/* TODO: Reimplement when a solution for youtube cross-origin exists */}
          {/* <button
            onClick={openPiP}
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
          >
            PiP
          </button> */}
        </div>

        {/* GRID */}
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